#import "SCMCNative.h"
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreMedia/CoreMedia.h>
#import <Accelerate/Accelerate.h>
#import <stdlib.h>
#import <string.h>
#import <math.h>

void SCMCNativeInstallMarker(void);

#pragma mark - Persistent store

static NSString *const SCMCPrefix = @"SCMC.";
static id SCMCGet(NSString *key) {
    id v = [[NSUserDefaults standardUserDefaults] objectForKey:[SCMCPrefix stringByAppendingString:key]];
    return v;
}
static void SCMCSet(NSString *key, id value) {
    if (value) [[NSUserDefaults standardUserDefaults] setObject:value forKey:[SCMCPrefix stringByAppendingString:key]];
    else [[NSUserDefaults standardUserDefaults] removeObjectForKey:[SCMCPrefix stringByAppendingString:key]];
}

#pragma mark - Native EQ (MTAudioProcessingTap)

typedef struct {
    double b0,b1,b2,a1,a2;
    double z1[2],z2[2];
} SCMCBiquad;

typedef struct {
    Float32 sampleRate;
    UInt32 channels;
    SCMCBiquad bq[7];
    double pre;
    BOOL enabled;
} SCMCEQState;

static const double kEQFreqs[7] = {60,150,400,1000,2400,6000,15000};

static void SCMCMakeFilter(SCMCBiquad *q, double fs, double f, double gain, BOOL lowShelf, BOOL highShelf) {
    double A = pow(10.0, gain / 40.0);
    double w0 = 2.0 * M_PI * f / fs;
    double c = cos(w0), s = sin(w0);
    double alpha = s / (2.0 * 0.70710678118);
    double a0,a1,a2,b0,b1,b2;
    if (lowShelf) {
        double twoSqrtAAlpha = 2.0 * sqrt(A) * alpha;
        b0 = A*((A+1)-(A-1)*c+twoSqrtAAlpha);
        b1 = 2*A*((A-1)-(A+1)*c);
        b2 = A*((A+1)-(A-1)*c-twoSqrtAAlpha);
        a0 = (A+1)+(A-1)*c+twoSqrtAAlpha;
        a1 = -2*((A-1)+(A+1)*c);
        a2 = (A+1)+(A-1)*c-twoSqrtAAlpha;
    } else if (highShelf) {
        double twoSqrtAAlpha = 2.0 * sqrt(A) * alpha;
        b0 = A*((A+1)+(A-1)*c+twoSqrtAAlpha);
        b1 = -2*A*((A-1)+(A+1)*c);
        b2 = A*((A+1)+(A-1)*c-twoSqrtAAlpha);
        a0 = (A+1)-(A-1)*c+twoSqrtAAlpha;
        a1 = 2*((A-1)-(A+1)*c);
        a2 = (A+1)-(A-1)*c-twoSqrtAAlpha;
    } else {
        b0 = 1 + alpha*A;
        b1 = -2*c;
        b2 = 1 - alpha*A;
        a0 = 1 + alpha/A;
        a1 = -2*c;
        a2 = 1 - alpha/A;
    }
    q->b0=b0/a0; q->b1=b1/a0; q->b2=b2/a0; q->a1=a1/a0; q->a2=a2/a0;
    /* Preserve filter delay state between audio render callbacks. */
}

static double SCMCProcessSample(SCMCBiquad *q, double x, int ch) {
    double y = q->b0*x + q->z1[ch];
    q->z1[ch] = q->b1*x - q->a1*y + q->z2[ch];
    q->z2[ch] = q->b2*x - q->a2*y;
    return y;
}

static void SCMCReloadEQ(SCMCEQState *st) {
    NSDictionary *eq = SCMCGet(@"eq");
    NSNumber *enabled = [eq isKindOfClass:[NSDictionary class]] ? eq[@"enabled"] : nil;
    NSNumber *preamp = [eq isKindOfClass:[NSDictionary class]] ? eq[@"preamp"] : nil;
    NSArray *gains = [eq isKindOfClass:[NSDictionary class]] ? eq[@"gains"] : nil;
    st->enabled = enabled ? enabled.boolValue : NO;
    double p = preamp ? preamp.doubleValue : 0.0;
    if (p > 12) p = 12; if (p < -12) p = -12;
    st->pre = pow(10.0, p / 20.0);
    for (int i=0;i<7;i++) {
        double g = (gains.count > i) ? [gains[i] doubleValue] : 0;
        if (g > 12) g = 12; if (g < -12) g = -12;
        SCMCMakeFilter(&st->bq[i], st->sampleRate > 1000 ? st->sampleRate : 48000, kEQFreqs[i], g, i==0, i==6);
    }
}

static void SCMCEQPrepare(MTAudioProcessingTapRef tap, CMItemCount maxFrames, const AudioStreamBasicDescription *format) {
    SCMCEQState *st = (SCMCEQState *)MTAudioProcessingTapGetStorage(tap);
    if (!st) return;
    st->sampleRate = format ? format->mSampleRate : 48000;
    st->channels = format ? format->mChannelsPerFrame : 2;
    if (st->channels < 1) st->channels = 1;
    if (st->channels > 2) st->channels = 2;
    SCMCReloadEQ(st);
}
static void SCMCEQUnprepare(MTAudioProcessingTapRef tap) {}
static void SCMCEQInit(MTAudioProcessingTapRef tap, void *clientInfo, void **tapStorageOut) {
    SCMCEQState *state = calloc(1, sizeof(SCMCEQState));
    if (tapStorageOut) *tapStorageOut = state;
    else free(state);
}
static void SCMCEQFinalize(MTAudioProcessingTapRef tap) {
    void *storage = MTAudioProcessingTapGetStorage(tap);
    if (storage) free(storage);
}

static void SCMCEQProcess(MTAudioProcessingTapRef tap, CMItemCount frameCount, MTAudioProcessingTapFlags flags, AudioBufferList *bufferListInOut, CMItemCount *numberFramesOut, MTAudioProcessingTapFlags *flagsOut) {
    SCMCEQState *st = (SCMCEQState *)MTAudioProcessingTapGetStorage(tap);
    if (!st) { if (numberFramesOut) *numberFramesOut = 0; return; }
    if (!st->sampleRate) st->sampleRate = 48000;
    SCMCReloadEQ(st);
    MTAudioProcessingTapGetSourceAudio(tap, frameCount, bufferListInOut, flagsOut, NULL, numberFramesOut);
    if (!st->enabled || !numberFramesOut || *numberFramesOut == 0) return;
    UInt32 frames = (UInt32)*numberFramesOut;
    UInt32 channels = st->channels > 2 ? 2 : st->channels;
    for (UInt32 b=0;b<bufferListInOut->mNumberBuffers;b++) {
        AudioBuffer *buf=&bufferListInOut->mBuffers[b];
        if (!buf->mData) continue;
        UInt32 chCount = buf->mNumberChannels ? buf->mNumberChannels : channels;
        if (chCount > 2) chCount=2;
        if (bufferListInOut->mNumberBuffers == 1 && chCount > 1) {
            if (buf->mDataByteSize >= frames*chCount*sizeof(Float32)) {
                Float32 *x=(Float32*)buf->mData;
                for (UInt32 n=0;n<frames;n++) for (UInt32 c=0;c<chCount;c++) {
                    double v=x[n*chCount+c]*st->pre;
                    for (int i=0;i<7;i++) v=SCMCProcessSample(&st->bq[i],v,(int)c);
                    x[n*chCount+c]=(Float32)fmax(-1.0,fmin(1.0,v));
                }
            }
        } else {
            Float32 *x=(Float32*)buf->mData;
            if (buf->mDataByteSize < frames*sizeof(Float32)) continue;
            int c=(int)b; if(c>1)c=1;
            for(UInt32 n=0;n<frames;n++) { double v=x[n]*st->pre; for(int i=0;i<7;i++)v=SCMCProcessSample(&st->bq[i],v,c); x[n]=(Float32)fmax(-1.0,fmin(1.0,v)); }
        }
    }
}

static MTAudioProcessingTapRef SCMCCreateTap(void) {
    MTAudioProcessingTapCallbacks cb;
    memset(&cb,0,sizeof(cb)); cb.version=kMTAudioProcessingTapCallbacksVersion_0; cb.clientInfo=NULL;
    cb.init=SCMCEQInit; cb.finalize=SCMCEQFinalize; cb.prepare=SCMCEQPrepare; cb.unprepare=SCMCEQUnprepare; cb.process=SCMCEQProcess;
    MTAudioProcessingTapRef tap=NULL;
    if (MTAudioProcessingTapCreate(kCFAllocatorDefault,&cb,kMTAudioProcessingTapCreationFlag_PreEffects,&tap)!=noErr) return NULL;
    return tap;
}

void SCMCInstallEQForPlayerItem(AVPlayerItem *item) {
    if (!item || ![item isKindOfClass:[AVPlayerItem class]]) return;
    NSDictionary *eq = SCMCGet(@"eq"); if (![eq isKindOfClass:[NSDictionary class]] || ![eq[@"enabled"] boolValue]) return;
    AVAsset *asset=item.asset; if(!asset) return;
    NSArray *tracks=[asset tracksWithMediaType:AVMediaTypeAudio]; if(!tracks.count) return;
    AVMutableAudioMix *mix=[AVMutableAudioMix audioMix]; NSMutableArray *params=[NSMutableArray array];
    for(AVAssetTrack *track in tracks){
        AVMutableAudioMixInputParameters *p=[AVMutableAudioMixInputParameters audioMixInputParametersWithTrack:track];
        MTAudioProcessingTapRef tap=SCMCCreateTap(); if(tap){ p.audioTapProcessor=tap; CFRelease(tap); }
        [params addObject:p];
    }
    mix.inputParameters=params; item.audioMix=mix;
}

#pragma mark - Native bridge

@interface SCMCPassthroughWebView : WKWebView
@property(nonatomic,assign) BOOL interactive;
@end
@implementation SCMCPassthroughWebView
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event { if(!self.interactive) return nil; return [super hitTest:point withEvent:event]; }
@end

@interface SCMCBridge : NSObject <WKScriptMessageHandler, WKNavigationDelegate>
@property(nonatomic,weak) WKWebView *webView;
@property(nonatomic,strong) UIView *host;
@property(nonatomic,strong) UIButton *fab;
@property(nonatomic,strong) NSString *mode;
@end

static UIButton *SCMCFindControl(UIView *root, NSString *kind) {
    for (UIView *v in root.subviews.reverseObjectEnumerator) {
        if ([v isKindOfClass:[UIButton class]]) {
            UIButton *b=(UIButton *)v; NSString *t=(b.accessibilityLabel ?: @""); NSString *tt=(b.currentTitle ?: @""); NSString *x=[NSString stringWithFormat:@"%@ %@",t,tt].lowercaseString;
            BOOL hit=NO;
            if([kind isEqualToString:@"toggle"]) hit=[x rangeOfString:@"play"].location!=NSNotFound || [x rangeOfString:@"pause"].location!=NSNotFound || [x rangeOfString:@"восп"].location!=NSNotFound;
            else if([kind isEqualToString:@"next"]) hit=[x rangeOfString:@"next"].location!=NSNotFound || [x rangeOfString:@"след"].location!=NSNotFound;
            else if([kind isEqualToString:@"prev"]) hit=[x rangeOfString:@"previous"].location!=NSNotFound || [x rangeOfString:@"пред"].location!=NSNotFound;
            else if([kind isEqualToString:@"like"]) hit=[x rangeOfString:@"like"].location!=NSNotFound || [x rangeOfString:@"нрав"].location!=NSNotFound;
            if(hit) return b;
        }
        UIButton *found=SCMCFindControl(v,kind); if(found) return found;
    }
    return nil;
}
static UIWindow *SCMCActiveWindow(void) {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        UIWindowScene *windowScene = (UIWindowScene *)scene;
        if (windowScene.activationState != UISceneActivationStateForegroundActive) continue;
        for (UIWindow *window in windowScene.windows) {
            if (window.isKeyWindow) return window;
        }
        if (windowScene.windows.firstObject) return windowScene.windows.firstObject;
    }
    return nil;
}

static UISlider *SCMCFindSlider(UIView *root) {
    for (UIView *v in root.subviews.reverseObjectEnumerator) { if([v isKindOfClass:[UISlider class]]) return (UISlider *)v; UISlider *s=SCMCFindSlider(v); if(s) return s; } return nil;
}

@implementation SCMCBridge

- (void)openCustomizer { self.mode=@"app"; SCMCPassthroughWebView *wv=(SCMCPassthroughWebView *)self.webView; wv.interactive=YES; [self showApp]; }
- (void)closeCustomizer { SCMCPassthroughWebView *wv=(SCMCPassthroughWebView *)self.webView; wv.interactive=NO; self.mode=@"closed"; }

- (void)sendState {
    MPNowPlayingInfoCenter *c=[MPNowPlayingInfoCenter defaultCenter]; NSDictionary *info=c.nowPlayingInfo ?: @{};
    NSNumber *dur=info[MPMediaItemPropertyPlaybackDuration]; NSNumber *elapsed=info[MPNowPlayingInfoPropertyElapsedPlaybackTime]; NSNumber *rate=info[MPNowPlayingInfoPropertyPlaybackRate];
    NSString *title=info[MPMediaItemPropertyTitle] ?: @""; NSString *artist=info[MPMediaItemPropertyArtist] ?: @""; NSString *album=info[MPMediaItemPropertyAlbumTitle] ?: @"";
    NSMutableDictionary *s=[@{ @"title":title, @"artist":artist, @"album":album, @"position":elapsed?:@0, @"duration":dur?:@0, @"playing":@((rate.doubleValue>0.01)) } mutableCopy];
    MPMediaItemArtwork *art=info[MPMediaItemPropertyArtwork]; if(art){ UIImage *im=[art imageWithSize:CGSizeMake(300,300)]; if(im){ NSData *d=UIImageJPEGRepresentation(im,0.85); if(d) s[@"art"]=@[@{ @"src":[NSString stringWithFormat:@"data:image/jpeg;base64,%@",[d base64EncodedStringWithOptions:0]], @"sizes":@"300x300" }]; } }
    NSData *d=[NSJSONSerialization dataWithJSONObject:s options:0 error:nil]; NSString *j=[[NSString alloc]initWithData:d encoding:NSUTF8StringEncoding];
    NSString *js=[NSString stringWithFormat:@"window.postMessage({__scc:'np-state',s:%@},'*');",j]; dispatch_async(dispatch_get_main_queue(),^{ [self.webView evaluateJavaScript:js completionHandler:nil]; });
}
- (void)command:(NSString *)cmd value:(NSNumber *)value {
    UIWindow *w=SCMCActiveWindow();
    if([cmd isEqualToString:@"seek"]) { UISlider *s=SCMCFindSlider(w); if(s && value){ NSNumber *durationNumber = [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo[MPMediaItemPropertyPlaybackDuration]; double dur=[durationNumber isKindOfClass:[NSNumber class]] ? durationNumber.doubleValue : 0.0; if(dur>0){ s.value=(float)(value.doubleValue/dur); [s sendActionsForControlEvents:UIControlEventValueChanged]; } } }
    else { UIButton *b=SCMCFindControl(w,cmd); if(b) [b sendActionsForControlEvents:UIControlEventTouchUpInside]; }
    [self sendState];
}

- (void)showOptions {
    ((SCMCPassthroughWebView *)self.webView).interactive=YES;
    self.mode=@"options";
    NSURL *u=[self resourceURL:@"options.html"]; if(u) [self.webView loadFileURL:u allowingReadAccessToURL:[u URLByDeletingLastPathComponent]];
}
- (NSURL *)resourceURL:(NSString *)name {
    // Ищем SCMusicPlus.bundle: рядом с dylib (deb и IPA/Frameworks), затем в корне .app и в .app/Frameworks.
    NSMutableArray<NSString *> *dirs=[NSMutableArray array];
    Dl_info info; memset(&info,0,sizeof(info));
    if(dladdr((const void *)&SCMCNativeInstallMarker,&info)!=0 && info.dli_fname) {
        [dirs addObject:[[NSString stringWithUTF8String:info.dli_fname] stringByDeletingLastPathComponent]];
    }
    NSString *app=[[NSBundle mainBundle] bundlePath];
    if(app.length) { [dirs addObject:[app stringByAppendingPathComponent:@"Frameworks"]]; [dirs addObject:app]; }
    NSFileManager *fm=[NSFileManager defaultManager];
    for(NSString *dir in dirs) {
        NSString *p=[[dir stringByAppendingPathComponent:@"SCMusicPlus.bundle"] stringByAppendingPathComponent:name];
        if([fm fileExistsAtPath:p]) return [NSURL fileURLWithPath:p];
    }
    return nil;
}
- (void)showApp { ((SCMCPassthroughWebView *)self.webView).interactive=YES; self.mode=@"app"; NSURL *u=[self resourceURL:@"app.html"]; if(u) [self.webView loadFileURL:u allowingReadAccessToURL:[u URLByDeletingLastPathComponent]]; }

- (void)userContentController:(WKUserContentController *)uc didReceiveScriptMessage:(WKScriptMessage *)message {
    if(![message.body isKindOfClass:[NSDictionary class]]) return; NSDictionary *b=message.body; NSString *op=b[@"op"];
    if([op isEqualToString:@"np"]) { [self command:b[@"cmd"] value:b[@"value"]]; return; }
    if([op isEqualToString:@"msg"]) { NSDictionary *m=b[@"msg"]; if([m[@"type"] isEqualToString:@"scc-ui"]) { NSString *a=m[@"action"]; if([a isEqualToString:@"overlay-interactive"]) { ((SCMCPassthroughWebView *)self.webView).interactive=[m[@"value"] boolValue]; return; } if([a isEqualToString:@"open-settings"]) [self showOptions]; else if([a isEqualToString:@"close"]) [self showApp]; else if([a isEqualToString:@"close-options"]) [self showApp]; else if([a isEqualToString:@"back"]) [self.webView goBack]; else if([a isEqualToString:@"fwd"]) [self.webView goForward]; else if([a isEqualToString:@"reload"]) [self sendState]; } return; }
    if([op isEqualToString:@"ui"]) { NSString *a=b[@"action"]; if([a isEqualToString:@"open-settings"]) [self showOptions]; else if([a isEqualToString:@"close-options"]) [self showApp]; else if([a isEqualToString:@"back"]) [self.webView goBack]; else if([a isEqualToString:@"fwd"]) [self.webView goForward]; else if([a isEqualToString:@"reload"]) [self sendState]; return; }
    if([op isEqualToString:@"haptic"]) { UIImpactFeedbackGenerator *g=[[UIImpactFeedbackGenerator alloc]initWithStyle:UIImpactFeedbackStyleLight]; [g impactOccurred]; return; }
    if([op isEqualToString:@"get"]) { NSDictionary *r=[self storeGet:b[@"keys"] defaults:b[@"defaults"]]; [self reply:r]; return; }
    if([op isEqualToString:@"set"]) { [self storeSet:b[@"items"]]; [self reply:@{}]; return; }
    if([op isEqualToString:@"remove"]) { NSMutableDictionary *ch=[NSMutableDictionary dictionary]; for(NSString *k in b[@"keys"]){ SCMCSet(k,nil); ch[k]=@{ @"newValue":[NSNull null] }; } [self broadcast:ch]; [self reply:@{}]; return; }
}
- (NSDictionary *)storeGet:(NSArray *)keys defaults:(NSDictionary *)defs { NSMutableDictionary *r=[NSMutableDictionary dictionary]; for(NSString *k in keys ?: @[]){ id v=SCMCGet(k); if(v) r[k]=v; else if(defs[k]) r[k]=defs[k]; } return r; }
- (void)broadcast:(NSDictionary *)changes { NSData *d=[NSJSONSerialization dataWithJSONObject:changes options:0 error:nil]; if(!d)return; NSString *j=[[NSString alloc]initWithData:d encoding:NSUTF8StringEncoding]; NSString *js=[NSString stringWithFormat:@"window.__sccStorageChanged && window.__sccStorageChanged(%@);",j]; dispatch_async(dispatch_get_main_queue(),^{ [self.webView evaluateJavaScript:js completionHandler:nil]; }); }
- (void)storeSet:(NSDictionary *)items { NSMutableDictionary *ch=[NSMutableDictionary dictionary]; [items enumerateKeysAndObjectsUsingBlock:^(NSString *k,id v,BOOL *stop){ SCMCSet(k,v); ch[k]=@{ @"newValue":v ?: [NSNull null] }; }]; [self broadcast:ch]; }
- (void)reply:(NSDictionary *)obj { NSData *d=[NSJSONSerialization dataWithJSONObject:obj options:0 error:nil]; NSString *j=[[NSString alloc]initWithData:d encoding:NSUTF8StringEncoding]; NSString *js=[NSString stringWithFormat:@"window.__sccNativeReply && window.__sccNativeReply(%@);",j]; [self.webView evaluateJavaScript:js completionHandler:nil]; }

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation { [self sendState]; }
@end

#pragma mark - Overlay injection

static SCMCBridge *gBridge;
static UIView *gOverlay;

static void SCMCShowOverlay(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if(gOverlay && gBridge) { gOverlay.hidden=NO; [gBridge sendState]; return; }
        UIWindow *w=SCMCActiveWindow(); if(!w) return;
        UIView *host=[[UIView alloc] initWithFrame:w.bounds]; host.backgroundColor=UIColor.clearColor; host.autoresizingMask=UIViewAutoresizingFlexibleWidth|UIViewAutoresizingFlexibleHeight;
        WKWebViewConfiguration *cfg=[WKWebViewConfiguration new]; cfg.allowsInlineMediaPlayback=YES; cfg.mediaTypesRequiringUserActionForPlayback=WKAudiovisualMediaTypeNone;
        WKUserContentController *ucc=[WKUserContentController new]; [ucc addScriptMessageHandler:(gBridge=[SCMCBridge new]) name:@"sccNative"]; cfg.userContentController=ucc;
        SCMCPassthroughWebView *wv=[[SCMCPassthroughWebView alloc] initWithFrame:host.bounds configuration:cfg]; wv.backgroundColor=UIColor.clearColor; wv.opaque=NO; wv.scrollView.backgroundColor=UIColor.clearColor; wv.autoresizingMask=UIViewAutoresizingFlexibleWidth|UIViewAutoresizingFlexibleHeight; gBridge.webView=wv;
        [host addSubview:wv]; [w addSubview:host]; gOverlay=host;
        UIButton *fab=[UIButton buttonWithType:UIButtonTypeSystem]; fab.frame=CGRectMake(w.bounds.size.width-68, w.bounds.size.height*0.62, 52, 52); fab.autoresizingMask=UIViewAutoresizingFlexibleLeftMargin|UIViewAutoresizingFlexibleTopMargin; fab.layer.cornerRadius=26; fab.backgroundColor=[UIColor colorWithWhite:0.12 alpha:0.92]; fab.tintColor=[UIColor colorWithRed:1 green:.33 blue:.08 alpha:1]; [fab setTitle:@"☷" forState:UIControlStateNormal]; fab.titleLabel.font=[UIFont systemFontOfSize:28 weight:UIFontWeightSemibold]; [host addSubview:fab]; gBridge.fab=fab; [fab addTarget:gBridge action:@selector(openCustomizer) forControlEvents:UIControlEventTouchUpInside];
        ((SCMCPassthroughWebView *)wv).interactive=NO;
    });
}

static void SCMCInstallOnMainThread(void) {
    static dispatch_once_t once; dispatch_once(&once, ^{ SCMCShowOverlay(); });
}

@interface UIViewController (SCMCOverlay)
@end
@implementation UIViewController (SCMCOverlay)
+ (void)scmc_presentIfRoot { SCMCInstallOnMainThread(); }
@end

void SCMCNativeInstallMarker(void) {}

@implementation SCMCNative
+ (void)install { dispatch_async(dispatch_get_main_queue(), ^{ SCMCInstallOnMainThread(); }); }
@end
