#import "SCMCNative.h"
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreMedia/CoreMedia.h>
#import <MediaToolbox/MediaToolbox.h>
#import <os/lock.h>
#import <stdlib.h>
#import <string.h>
#import <math.h>
#import <execinfo.h>
#import <signal.h>
#import <fcntl.h>
#import <unistd.h>
#import <sys/stat.h>
#import <stdarg.h>

#pragma mark - Журнал, перехват падений и «безопасные уровни»

// Журнал лежит в Documents (виден в приложении «Файлы» → На iPhone → SoundCloud): scmc.log
// Файл scmc-level.txt хранит «уровень»: если прошлый запуск не дожил до подтверждения (приложение упало
// сразу после старта), следующий запуск автоматически отключает часть функций: 1 — оверлей и эквалайзер,
// 2 — ещё и хуки Foundation/сети, 3 — все хуки. Чтобы сбросить уровень, удалите scmc-level.txt.

static int gLogFD = -1;
static int gLevel = 0;

static NSString *SCMCDocumentsDir(void) {
    NSArray<NSString *> *d = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    return d.firstObject ?: NSTemporaryDirectory();
}

static void SCMCLogOpen(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *p = [SCMCDocumentsDir() stringByAppendingPathComponent:@"scmc.log"];
        struct stat st;
        if (stat(p.fileSystemRepresentation, &st) == 0 && st.st_size > 200 * 1024) unlink(p.fileSystemRepresentation);
        gLogFD = open(p.fileSystemRepresentation, O_WRONLY | O_CREAT | O_APPEND, 0644);
    });
}

void SCMCLog(NSString *fmt, ...) {
    SCMCLogOpen();
    if (gLogFD < 0) return;
    va_list ap;
    va_start(ap, fmt);
    NSString *msg = [[NSString alloc] initWithFormat:fmt arguments:ap];
    va_end(ap);
    NSString *line = [NSString stringWithFormat:@"[%.2f pid=%d] %@\n", [NSProcessInfo processInfo].systemUptime, getpid(), msg];
    const char *u = line.UTF8String;
    if (u) write(gLogFD, u, strlen(u));
}

static void SCMCSignalHandler(int sig) {
    if (gLogFD >= 0) {
        char buf[64];
        int n = snprintf(buf, sizeof(buf), "\n*** CRASH: signal %d, level %d\n", sig, gLevel);
        write(gLogFD, buf, n);
        void *frames[64];
        int cnt = backtrace(frames, 64);
        backtrace_symbols_fd(frames, cnt, gLogFD);
        write(gLogFD, "*** END\n", 8);
    }
    signal(sig, SIG_DFL);
    raise(sig);
}

static void SCMCExceptionHandler(NSException *e) {
    SCMCLog(@"*** UNCAUGHT EXCEPTION %@: %@\n%@", e.name, e.reason, e.callStackSymbols);
}

static NSString *SCMCStatePath(void) {
    return [SCMCDocumentsDir() stringByAppendingPathComponent:@"scmc-level.txt"];
}

static void SCMCWriteState(int level, int armed) {
    [[NSString stringWithFormat:@"%d,%d\n", level, armed] writeToFile:SCMCStatePath() atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

static void SCMCConfirmAlive(void) {
    static BOOL done = NO;
    if (done) return;
    done = YES;
    SCMCWriteState(gLevel, 0);
    SCMCLog(@"launch confirmed alive (level %d)", gLevel);
}

int SCMCBeginLaunch(void) {
    int level = 0, armed = 0;
    NSString *s = [NSString stringWithContentsOfFile:SCMCStatePath() encoding:NSUTF8StringEncoding error:nil];
    if (s.length) sscanf(s.UTF8String, "%d,%d", &level, &armed);
    if (level < 0 || level > 3) level = 0;
    BOOL escalated = NO;
    if (armed == 1 && level < 3) { level++; escalated = YES; }   // прошлый запуск умер, не дожив до подтверждения
    gLevel = level;
    SCMCWriteState(level, 1);
    SCMCLog(@"=== launch, safe level %d%@ ===", level, escalated ? @" (повышен: прошлый запуск упал)" : @"");

    NSSetUncaughtExceptionHandler(&SCMCExceptionHandler);
    int sigs[] = { SIGSEGV, SIGBUS, SIGABRT, SIGILL, SIGTRAP, SIGFPE };
    for (size_t i = 0; i < sizeof(sigs) / sizeof(sigs[0]); i++) signal(sigs[i], SCMCSignalHandler);

    // «Дожили» = 10 секунд работы или уход в фон (пользователь свернул/закрыл приложение сам).
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ SCMCConfirmAlive(); });
    [[NSNotificationCenter defaultCenter] addObserverForName:UIApplicationDidEnterBackgroundNotification object:nil queue:nil usingBlock:^(NSNotification *n) { SCMCConfirmAlive(); }];
    return level;
}

#pragma mark - Защита от двойной инъекции

// Если в базовом IPA уже есть копия этого твика, вторая копия не должна ставить хуки повторно.
BOOL SCMCClaimProcess(void) {
    static const char *kEnv = "SCMC_TWEAK_LOADED";
    if (getenv(kEnv)) return NO;
    setenv(kEnv, "1", 1);
    return YES;
}

#pragma mark - JSON helpers

static NSString *SCMCJSONString(id obj, NSString *fallback) {
    // dataWithJSONObject: бросает исключение (а не возвращает error) на NaN/Inf/неподдерживаемых типах —
    // в чужом процессе это падение всего приложения, поэтому сначала проверяем.
    if (!obj || ![NSJSONSerialization isValidJSONObject:obj]) return fallback;
    NSData *d = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
    NSString *s = d ? [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] : nil;
    return s ?: fallback;
}

#pragma mark - Persistent store (файл в Application Support, не NSUserDefaults)

// Раньше настройки (включая видео-фон кусками base64) писались в NSUserDefaults самого SoundCloud —
// это раздувало их plist и тормозило запуск приложения. Теперь отдельный JSON-файл.

static NSObject *gStoreLock;
static NSMutableDictionary *gStore;
static dispatch_queue_t gStoreIO;

static NSString *SCMCStorePath(void) {
    NSArray<NSString *> *dirs = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES);
    NSString *base = dirs.firstObject ?: NSTemporaryDirectory();
    NSString *dir = [base stringByAppendingPathComponent:@"SCMusicPlus"];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    return [dir stringByAppendingPathComponent:@"store.json"];
}

static void SCMCStoreEnsure(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        gStoreLock = [NSObject new];
        gStoreIO = dispatch_queue_create("scmc.store.io", DISPATCH_QUEUE_SERIAL);
        gStore = [NSMutableDictionary dictionary];
        NSData *d = [NSData dataWithContentsOfFile:SCMCStorePath()];
        id obj = d.length ? [NSJSONSerialization JSONObjectWithData:d options:0 error:nil] : nil;
        if ([obj isKindOfClass:[NSDictionary class]]) [gStore addEntriesFromDictionary:obj];

        // Одноразовая миграция старых ключей "SCMC.*" из NSUserDefaults.
        NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
        NSDictionary *all = [ud dictionaryRepresentation];
        BOOL migrated = NO;
        for (NSString *k in all.allKeys) {
            if (![k isKindOfClass:[NSString class]] || ![k hasPrefix:@"SCMC."]) continue;
            id v = all[k];
            NSString *nk = [k substringFromIndex:5];
            if (nk.length && gStore[nk] == nil && [NSJSONSerialization isValidJSONObject:@{ @"v": v }]) { gStore[nk] = v; migrated = YES; }
            [ud removeObjectForKey:k];
        }
        if (migrated) {
            NSData *out = [NSJSONSerialization dataWithJSONObject:gStore options:0 error:nil];
            if (out) [out writeToFile:SCMCStorePath() atomically:YES];
        }
    });
}

static void SCMCStoreScheduleFlush(void) {
    static BOOL pending = NO;
    @synchronized (gStoreLock) {
        if (pending) return;
        pending = YES;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.4 * NSEC_PER_SEC)), gStoreIO, ^{
        NSDictionary *snap;
        @synchronized (gStoreLock) {
            pending = NO;
            snap = [gStore copy];
        }
        NSString *json = SCMCJSONString(snap, nil);
        if (json) [[json dataUsingEncoding:NSUTF8StringEncoding] writeToFile:SCMCStorePath() atomically:YES];
    });
}

static id SCMCGet(NSString *key) {
    SCMCStoreEnsure();
    @synchronized (gStoreLock) { return gStore[key]; }
}

static void SCMCEQConfigUpdateFromStore(void);

static void SCMCSet(NSString *key, id value) {
    if (![key isKindOfClass:[NSString class]] || key.length == 0) return;
    SCMCStoreEnsure();
    @synchronized (gStoreLock) {
        if (value) gStore[key] = value;
        else [gStore removeObjectForKey:key];
    }
    SCMCStoreScheduleFlush();
    if ([key isEqualToString:@"eq"]) SCMCEQConfigUpdateFromStore();
}

#pragma mark - Native EQ (MTAudioProcessingTap)

typedef struct {
    double b0, b1, b2, a1, a2;
    double z1[2], z2[2];
} SCMCBiquad;

// Глобальная конфигурация: пишется только с основного потока, читается из аудио-потока через trylock.
typedef struct {
    BOOL enabled;
    double pre;
    double gains[7];
    uint32_t version;
} SCMCEQConfig;

static SCMCEQConfig gEQConfig;
static os_unfair_lock gEQLock = OS_UNFAIR_LOCK_INIT;

typedef struct {
    Float32 sampleRate;
    UInt32 channels;
    BOOL supported;
    uint32_t cfgVersion;
    BOOL enabled;
    double pre;
    SCMCBiquad bq[7];
} SCMCEQState;

static const double kEQFreqs[7] = {60, 150, 400, 1000, 2400, 6000, 15000};

static void SCMCMakeFilter(SCMCBiquad *q, double fs, double f, double gain, BOOL lowShelf, BOOL highShelf) {
    double A = pow(10.0, gain / 40.0);
    double w0 = 2.0 * M_PI * f / fs;
    double c = cos(w0), s = sin(w0);
    double alpha = s / (2.0 * 0.70710678118);
    double a0, a1, a2, b0, b1, b2;
    if (lowShelf) {
        double t = 2.0 * sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * c + t);
        b1 = 2 * A * ((A - 1) - (A + 1) * c);
        b2 = A * ((A + 1) - (A - 1) * c - t);
        a0 = (A + 1) + (A - 1) * c + t;
        a1 = -2 * ((A - 1) + (A + 1) * c);
        a2 = (A + 1) + (A - 1) * c - t;
    } else if (highShelf) {
        double t = 2.0 * sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * c + t);
        b1 = -2 * A * ((A - 1) + (A + 1) * c);
        b2 = A * ((A + 1) + (A - 1) * c - t);
        a0 = (A + 1) - (A - 1) * c + t;
        a1 = 2 * ((A - 1) - (A + 1) * c);
        a2 = (A + 1) - (A - 1) * c - t;
    } else {
        b0 = 1 + alpha * A;
        b1 = -2 * c;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * c;
        a2 = 1 - alpha / A;
    }
    // Состояние фильтра (z1/z2) намеренно не трогаем — оно живёт между вызовами рендера.
    q->b0 = b0 / a0; q->b1 = b1 / a0; q->b2 = b2 / a0; q->a1 = a1 / a0; q->a2 = a2 / a0;
}

static double SCMCProcessSample(SCMCBiquad *q, double x, int ch) {
    double y = q->b0 * x + q->z1[ch];
    q->z1[ch] = q->b1 * x - q->a1 * y + q->z2[ch];
    q->z2[ch] = q->b2 * x - q->a2 * y;
    return y;
}

static double SCMCClamp(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }

static void SCMCEQConfigUpdateFromStore(void) {
    id eq = SCMCGet(@"eq");
    NSDictionary *d = [eq isKindOfClass:[NSDictionary class]] ? eq : nil;
    NSNumber *enabled = [d[@"enabled"] isKindOfClass:[NSNumber class]] ? d[@"enabled"] : nil;
    NSNumber *preamp = [d[@"preamp"] isKindOfClass:[NSNumber class]] ? d[@"preamp"] : nil;
    NSArray *gains = [d[@"gains"] isKindOfClass:[NSArray class]] ? d[@"gains"] : nil;

    SCMCEQConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.enabled = enabled ? enabled.boolValue : NO;
    cfg.pre = pow(10.0, SCMCClamp(preamp ? preamp.doubleValue : 0.0, -12, 12) / 20.0);
    for (int i = 0; i < 7; i++) {
        double g = 0;
        if ((int)gains.count > i && [gains[i] isKindOfClass:[NSNumber class]]) g = [gains[i] doubleValue];
        cfg.gains[i] = SCMCClamp(g, -12, 12);
    }
    os_unfair_lock_lock(&gEQLock);
    cfg.version = gEQConfig.version + 1;
    gEQConfig = cfg;
    os_unfair_lock_unlock(&gEQLock);
}

static void SCMCEQEnsureLoaded(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        SCMCStoreEnsure();
        SCMCEQConfigUpdateFromStore();
    });
}

static BOOL SCMCEQIsEnabled(void) {
    SCMCEQEnsureLoaded();
    os_unfair_lock_lock(&gEQLock);
    BOOL on = gEQConfig.enabled;
    os_unfair_lock_unlock(&gEQLock);
    return on;
}

// Подтягивает глобальную конфигурацию в состояние тапа. В аудио-потоке block=NO: если замок занят — просто
// продолжаем со старыми коэффициентами (никаких ожиданий, аллокаций и Objective-C в реальном времени).
static void SCMCEQSync(SCMCEQState *st, BOOL block) {
    SCMCEQConfig cfg;
    if (block) os_unfair_lock_lock(&gEQLock);
    else if (!os_unfair_lock_trylock(&gEQLock)) return;
    cfg = gEQConfig;
    os_unfair_lock_unlock(&gEQLock);
    if (st->cfgVersion == cfg.version && st->cfgVersion != 0) return;
    st->cfgVersion = cfg.version ?: 1;
    st->enabled = cfg.enabled;
    st->pre = cfg.pre;
    double fs = st->sampleRate > 1000 ? st->sampleRate : 48000;
    for (int i = 0; i < 7; i++) SCMCMakeFilter(&st->bq[i], fs, kEQFreqs[i], cfg.gains[i], i == 0, i == 6);
}

static void SCMCEQInit(MTAudioProcessingTapRef tap, void *clientInfo, void **tapStorageOut) {
    SCMCEQState *state = calloc(1, sizeof(SCMCEQState));
    if (tapStorageOut) *tapStorageOut = state;
    else free(state);
}

static void SCMCEQFinalize(MTAudioProcessingTapRef tap) {
    void *storage = MTAudioProcessingTapGetStorage(tap);
    if (storage) free(storage);
}

static void SCMCEQPrepare(MTAudioProcessingTapRef tap, CMItemCount maxFrames, const AudioStreamBasicDescription *format) {
    SCMCEQState *st = (SCMCEQState *)MTAudioProcessingTapGetStorage(tap);
    if (!st) return;
    st->sampleRate = format ? (Float32)format->mSampleRate : 48000;
    st->channels = format ? format->mChannelsPerFrame : 2;
    if (st->channels < 1) st->channels = 1;
    if (st->channels > 2) st->channels = 2;
    // Обрабатываем только 32-битный float PCM; иначе тап работает как проходной.
    st->supported = format && (format->mFormatFlags & kAudioFormatFlagIsFloat) && format->mBitsPerChannel == 32;
    st->cfgVersion = 0;
    SCMCEQSync(st, YES);
}

static void SCMCEQUnprepare(MTAudioProcessingTapRef tap) {}

static void SCMCEQProcess(MTAudioProcessingTapRef tap, CMItemCount frameCount, MTAudioProcessingTapFlags flags,
                          AudioBufferList *bufferListInOut, CMItemCount *numberFramesOut, MTAudioProcessingTapFlags *flagsOut) {
    // Источник нужно запросить всегда — иначе в буфере мусор.
    OSStatus status = MTAudioProcessingTapGetSourceAudio(tap, frameCount, bufferListInOut, flagsOut, NULL, numberFramesOut);
    SCMCEQState *st = (SCMCEQState *)MTAudioProcessingTapGetStorage(tap);
    if (status != noErr || !st || !numberFramesOut || *numberFramesOut <= 0) return;
    SCMCEQSync(st, NO);
    if (!st->enabled || !st->supported) return;

    UInt32 frames = (UInt32)*numberFramesOut;
    UInt32 channels = st->channels > 2 ? 2 : st->channels;
    for (UInt32 b = 0; b < bufferListInOut->mNumberBuffers; b++) {
        AudioBuffer *buf = &bufferListInOut->mBuffers[b];
        if (!buf->mData) continue;
        UInt32 chCount = buf->mNumberChannels ? buf->mNumberChannels : channels;
        if (chCount > 2) chCount = 2;
        if (bufferListInOut->mNumberBuffers == 1 && chCount > 1) {
            // interleaved
            if (buf->mDataByteSize < frames * buf->mNumberChannels * sizeof(Float32)) continue;
            Float32 *x = (Float32 *)buf->mData;
            UInt32 stride = buf->mNumberChannels;
            for (UInt32 n = 0; n < frames; n++) {
                for (UInt32 c = 0; c < chCount; c++) {
                    double v = x[n * stride + c] * st->pre;
                    for (int i = 0; i < 7; i++) v = SCMCProcessSample(&st->bq[i], v, (int)c);
                    x[n * stride + c] = (Float32)SCMCClamp(v, -1.0, 1.0);
                }
            }
        } else {
            // non-interleaved: каждый буфер — отдельный канал
            if (buf->mDataByteSize < frames * sizeof(Float32)) continue;
            Float32 *x = (Float32 *)buf->mData;
            int c = (int)b; if (c > 1) c = 1;
            for (UInt32 n = 0; n < frames; n++) {
                double v = x[n] * st->pre;
                for (int i = 0; i < 7; i++) v = SCMCProcessSample(&st->bq[i], v, c);
                x[n] = (Float32)SCMCClamp(v, -1.0, 1.0);
            }
        }
    }
}

static MTAudioProcessingTapRef SCMCCreateTap(void) {
    MTAudioProcessingTapCallbacks cb;
    memset(&cb, 0, sizeof(cb));
    cb.version = kMTAudioProcessingTapCallbacksVersion_0;
    cb.clientInfo = NULL;
    cb.init = SCMCEQInit; cb.finalize = SCMCEQFinalize; cb.prepare = SCMCEQPrepare;
    cb.unprepare = SCMCEQUnprepare; cb.process = SCMCEQProcess;
    MTAudioProcessingTapRef tap = NULL;
    if (MTAudioProcessingTapCreate(kCFAllocatorDefault, &cb, kMTAudioProcessingTapCreationFlag_PreEffects, &tap) != noErr) return NULL;
    return tap;
}

static const void *kSCMCMixKey = &kSCMCMixKey;      // помечает AVAudioMix, созданный нами
static const void *kSCMCPendingKey = &kSCMCPendingKey; // помечает AVPlayerItem, для которого идёт асинхронная загрузка треков
static __thread BOOL gEQBusy;                        // защита от рекурсии setAudioMix: -> install -> setAudioMix:

BOOL SCMCAudioMixIsOurs(AVAudioMix *mix) {
    return mix && [objc_getAssociatedObject(mix, kSCMCMixKey) boolValue];
}

static void SCMCApplyEQ(AVPlayerItem *item) {
    if (!item || SCMCAudioMixIsOurs(item.audioMix)) return;
    NSArray<AVAssetTrack *> *tracks = [item.asset tracksWithMediaType:AVMediaTypeAudio];
    if (!tracks.count) return;
    AVMutableAudioMix *mix = [AVMutableAudioMix audioMix];
    NSMutableArray *params = [NSMutableArray array];
    for (AVAssetTrack *track in tracks) {
        AVMutableAudioMixInputParameters *p = [AVMutableAudioMixInputParameters audioMixInputParametersWithTrack:track];
        MTAudioProcessingTapRef tap = SCMCCreateTap();
        if (tap) { p.audioTapProcessor = tap; CFRelease(tap); }
        [params addObject:p];
    }
    mix.inputParameters = params;
    objc_setAssociatedObject(mix, kSCMCMixKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    gEQBusy = YES;
    item.audioMix = mix;
    gEQBusy = NO;
}

void SCMCInstallEQForPlayerItem(AVPlayerItem *item) {
    if (gEQBusy) return;
    if (!item || ![item isKindOfClass:[AVPlayerItem class]]) return;
    if (!SCMCEQIsEnabled()) return;
    if (SCMCAudioMixIsOurs(item.audioMix)) return;
    AVAsset *asset = item.asset;
    if (!asset) return;

    // tracksWithMediaType: на незагруженном удалённом ассете блокирует поток (на главном — это зависание/убийство
    // приложения watchdog'ом). Поэтому треки грузим асинхронно.
    if ([asset statusOfValueForKey:@"tracks" error:nil] == AVKeyValueStatusLoaded) {
        SCMCApplyEQ(item);
        return;
    }
    if ([objc_getAssociatedObject(item, kSCMCPendingKey) boolValue]) return;
    objc_setAssociatedObject(item, kSCMCPendingKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    __weak AVPlayerItem *weakItem = item;
    [asset loadValuesAsynchronouslyForKeys:@[ @"tracks" ] completionHandler:^{
        dispatch_async(dispatch_get_main_queue(), ^{
            AVPlayerItem *it = weakItem;
            if (!it) return;
            objc_setAssociatedObject(it, kSCMCPendingKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            if ([it.asset statusOfValueForKey:@"tracks" error:nil] == AVKeyValueStatusLoaded) SCMCApplyEQ(it);
        });
    }];
}

#pragma mark - Native bridge

@interface SCMCPassthroughWebView : WKWebView
@property (nonatomic, assign) BOOL interactive;
@end
@implementation SCMCPassthroughWebView
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
    if (!self.interactive) return nil;
    return [super hitTest:point withEvent:event];
}
@end

// Контейнер оверлея: сам касания не принимает (иначе он перекрывает всё приложение SoundCloud),
// пропускает только дочерние вью (кнопка и интерактивный WebView).
@interface SCMCPassthroughView : UIView
@end
@implementation SCMCPassthroughView
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
    UIView *v = [super hitTest:point withEvent:event];
    return v == self ? nil : v;
}
@end

static UIView *gOverlay;

@interface SCMCBridge : NSObject <WKScriptMessageHandler, WKNavigationDelegate>
@property (nonatomic, weak) WKWebView *webView;
@property (nonatomic, strong) UIButton *fab;
@property (nonatomic, strong) NSString *mode;
@property (nonatomic, copy) NSString *artKey;
@property (nonatomic, copy) NSString *artURL;
@property (nonatomic, assign) BOOL artBusy;
@end

static UIWindow *SCMCActiveWindow(void) {
    UIApplication *app = UIApplication.sharedApplication;
    if (!app) return nil;
    UIWindow *best = nil;
    for (UIScene *scene in app.connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        UIWindowScene *ws = (UIWindowScene *)scene;
        if (ws.activationState == UISceneActivationStateUnattached || ws.activationState == UISceneActivationStateBackground) continue;
        for (UIWindow *w in ws.windows) {
            if (w.isHidden || w.windowLevel != UIWindowLevelNormal) continue;
            if (w.isKeyWindow) return w;
            if (!best) best = w;
        }
    }
    if (best) return best;
    // Приложения без UIScene (классический AppDelegate.window).
    for (UIWindow *w in app.windows) {
        if (w.isHidden || w.windowLevel != UIWindowLevelNormal) continue;
        if (w.isKeyWindow) return w;
        if (!best) best = w;
    }
    if (best) return best;
    id delegate = app.delegate;
    if ([delegate respondsToSelector:@selector(window)]) {
        id w = [delegate performSelector:@selector(window)];
        if ([w isKindOfClass:[UIWindow class]]) return w;
    }
    return nil;
}

static UIButton *SCMCFindControl(UIView *root, NSString *kind) {
    for (UIView *v in root.subviews.reverseObjectEnumerator) {
        if (v == gOverlay) continue; // свой оверлей не обходим
        if ([v isKindOfClass:[UIButton class]]) {
            UIButton *b = (UIButton *)v;
            NSString *x = [NSString stringWithFormat:@"%@ %@", b.accessibilityLabel ?: @"", b.currentTitle ?: @""].lowercaseString;
            BOOL hit = NO;
            if ([kind isEqualToString:@"toggle"]) hit = [x containsString:@"play"] || [x containsString:@"pause"] || [x containsString:@"восп"];
            else if ([kind isEqualToString:@"next"]) hit = [x containsString:@"next"] || [x containsString:@"след"];
            else if ([kind isEqualToString:@"prev"]) hit = [x containsString:@"previous"] || [x containsString:@"пред"];
            else if ([kind isEqualToString:@"like"]) hit = [x containsString:@"like"] || [x containsString:@"нрав"];
            if (hit) return b;
        }
        UIButton *found = SCMCFindControl(v, kind);
        if (found) return found;
    }
    return nil;
}

static UISlider *SCMCFindSlider(UIView *root) {
    for (UIView *v in root.subviews.reverseObjectEnumerator) {
        if (v == gOverlay) continue;
        if ([v isKindOfClass:[UISlider class]]) return (UISlider *)v;
        UISlider *s = SCMCFindSlider(v);
        if (s) return s;
    }
    return nil;
}

@implementation SCMCBridge

- (SCMCPassthroughWebView *)pwv { return (SCMCPassthroughWebView *)self.webView; }

- (void)openCustomizer { self.mode = @"app"; [self pwv].interactive = YES; [self showApp]; }
- (void)closeCustomizer { [self pwv].interactive = NO; self.mode = @"closed"; }

- (void)pushState:(NSDictionary *)s {
    NSString *js = [NSString stringWithFormat:@"window.postMessage({__scc:'np-state',s:%@},'*');", SCMCJSONString(s, @"{}")];
    [self evalOnMain:js];
}

- (void)sendState {
    MPNowPlayingInfoCenter *c = [MPNowPlayingInfoCenter defaultCenter];
    NSDictionary *info = c.nowPlayingInfo ?: @{};
    NSNumber *dur = [info[MPMediaItemPropertyPlaybackDuration] isKindOfClass:[NSNumber class]] ? info[MPMediaItemPropertyPlaybackDuration] : nil;
    NSNumber *elapsed = [info[MPNowPlayingInfoPropertyElapsedPlaybackTime] isKindOfClass:[NSNumber class]] ? info[MPNowPlayingInfoPropertyElapsedPlaybackTime] : nil;
    NSNumber *rate = [info[MPNowPlayingInfoPropertyPlaybackRate] isKindOfClass:[NSNumber class]] ? info[MPNowPlayingInfoPropertyPlaybackRate] : nil;
    NSString *title = [info[MPMediaItemPropertyTitle] isKindOfClass:[NSString class]] ? info[MPMediaItemPropertyTitle] : @"";
    NSString *artist = [info[MPMediaItemPropertyArtist] isKindOfClass:[NSString class]] ? info[MPMediaItemPropertyArtist] : @"";
    NSString *album = [info[MPMediaItemPropertyAlbumTitle] isKindOfClass:[NSString class]] ? info[MPMediaItemPropertyAlbumTitle] : @"";
    double durV = dur.doubleValue, elV = elapsed.doubleValue;
    NSMutableDictionary *s = [@{ @"title": title, @"artist": artist, @"album": album,
                                 @"position": @(isfinite(elV) ? elV : 0), @"duration": @(isfinite(durV) ? durV : 0),
                                 @"playing": @(rate.doubleValue > 0.01) } mutableCopy];

    // Обложка: кодируем один раз на трек и НЕ на главном потоке (imageWithSize: вызывает код SoundCloud,
    // который может синхронно ждать главный поток).
    NSString *key = [NSString stringWithFormat:@"%@|%@|%@", title, artist, album];
    if ([key isEqualToString:self.artKey]) {
        if (self.artURL.length) s[@"art"] = @[ @{ @"src": self.artURL, @"sizes": @"300x300" } ];
    } else if (!self.artBusy) {
        MPMediaItemArtwork *art = [info[MPMediaItemPropertyArtwork] isKindOfClass:[MPMediaItemArtwork class]] ? info[MPMediaItemPropertyArtwork] : nil;
        if (!art) {
            self.artKey = key; self.artURL = @"";
        } else {
            self.artBusy = YES;
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                NSString *url = @"";
                @try {
                    UIImage *im = [art imageWithSize:CGSizeMake(300, 300)];
                    NSData *d = im ? UIImageJPEGRepresentation(im, 0.8) : nil;
                    if (d) url = [NSString stringWithFormat:@"data:image/jpeg;base64,%@", [d base64EncodedStringWithOptions:0]];
                } @catch (NSException *e) {}
                dispatch_async(dispatch_get_main_queue(), ^{
                    self.artKey = key; self.artURL = url; self.artBusy = NO;
                    [self sendState];
                });
            });
        }
    }
    [self pushState:s];
}

- (void)command:(NSString *)cmd value:(NSNumber *)value {
    if (![cmd isKindOfClass:[NSString class]]) return;
    // Опрос состояния («get») идёт каждые 0.5 с — раньше он каждый раз обходил ВСЕ вью SoundCloud и кодировал обложку
    // на главном потоке, отсюда «намертво зависает».
    if (![cmd isEqualToString:@"seek"] && ![cmd isEqualToString:@"toggle"] && ![cmd isEqualToString:@"next"] &&
        ![cmd isEqualToString:@"prev"] && ![cmd isEqualToString:@"like"]) { [self sendState]; return; }
    UIWindow *w = SCMCActiveWindow();
    if ([cmd isEqualToString:@"seek"]) {
        UISlider *s = w ? SCMCFindSlider(w) : nil;
        if (s && [value isKindOfClass:[NSNumber class]]) {
            id dn = [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo[MPMediaItemPropertyPlaybackDuration];
            double dur = [dn isKindOfClass:[NSNumber class]] ? [dn doubleValue] : 0.0;
            if (dur > 0 && isfinite(value.doubleValue)) {
                s.value = (float)(value.doubleValue / dur);
                [s sendActionsForControlEvents:UIControlEventValueChanged];
            }
        }
    } else if (w) {
        UIButton *b = SCMCFindControl(w, cmd);
        if (b) [b sendActionsForControlEvents:UIControlEventTouchUpInside];
    }
    [self sendState];
}

// Ищем SCMusicPlus.bundle: рядом с dylib (deb и IPA/Frameworks), затем в .app/Frameworks и в корне .app.
- (NSString *)bundleRoot {
    static NSString *cached;
    if (cached) return cached;
    NSMutableArray<NSString *> *dirs = [NSMutableArray array];
    Dl_info info; memset(&info, 0, sizeof(info));
    if (dladdr((const void *)&SCMCNativeInstallMarker, &info) != 0 && info.dli_fname) {
        [dirs addObject:[[NSString stringWithUTF8String:info.dli_fname] stringByDeletingLastPathComponent]];
    }
    NSString *app = [[NSBundle mainBundle] bundlePath];
    if (app.length) { [dirs addObject:[app stringByAppendingPathComponent:@"Frameworks"]]; [dirs addObject:app]; }
    NSFileManager *fm = [NSFileManager defaultManager];
    for (NSString *dir in dirs) {
        NSString *root = [dir stringByAppendingPathComponent:@"SCMusicPlus.bundle"];
        if ([fm fileExistsAtPath:[root stringByAppendingPathComponent:@"app.html"]]) { cached = root; return root; }
    }
    return nil;
}

- (void)loadPage:(NSString *)relativePath {
    NSString *root = [self bundleRoot];
    if (!root || !self.webView) return;
    NSString *p = [root stringByAppendingPathComponent:relativePath];
    if (![[NSFileManager defaultManager] fileExistsAtPath:p]) return;
    // Доступ на чтение — ко всему бандлу: страница настроек (Web/ext) подтягивает ../../native-bridge.js.
    [self.webView loadFileURL:[NSURL fileURLWithPath:p] allowingReadAccessToURL:[NSURL fileURLWithPath:root isDirectory:YES]];
}

- (void)showApp { [self pwv].interactive = YES; self.mode = @"app"; [self loadPage:@"app.html"]; }
- (void)showOptions { [self pwv].interactive = YES; self.mode = @"options"; [self loadPage:@"Web/ext/options.html"]; }

- (void)userContentController:(WKUserContentController *)uc didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.body isKindOfClass:[NSDictionary class]]) return;
    NSDictionary *b = message.body;
    NSString *op = [b[@"op"] isKindOfClass:[NSString class]] ? b[@"op"] : @"";

    if ([op isEqualToString:@"np"]) { [self command:b[@"cmd"] value:b[@"value"]]; return; }

    if ([op isEqualToString:@"msg"]) {
        NSDictionary *m = [b[@"msg"] isKindOfClass:[NSDictionary class]] ? b[@"msg"] : nil;
        if ([m[@"type"] isEqual:@"scc-ui"]) {
            NSString *a = [m[@"action"] isKindOfClass:[NSString class]] ? m[@"action"] : @"";
            if ([a isEqualToString:@"overlay-interactive"]) { [self pwv].interactive = [m[@"value"] boolValue]; return; }
            [self handleUIAction:a];
        }
        return;
    }
    if ([op isEqualToString:@"ui"]) { [self handleUIAction:[b[@"action"] isKindOfClass:[NSString class]] ? b[@"action"] : @""]; return; }

    if ([op isEqualToString:@"haptic"]) {
        UIImpactFeedbackGenerator *g = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
        [g impactOccurred];
        return;
    }
    if ([op isEqualToString:@"get"]) {
        NSArray *keys = [b[@"keys"] isKindOfClass:[NSArray class]] ? b[@"keys"] : nil;
        NSDictionary *defs = [b[@"defaults"] isKindOfClass:[NSDictionary class]] ? b[@"defaults"] : nil;
        [self reply:[self storeGet:keys defaults:defs] forId:b[@"id"]];
        return;
    }
    if ([op isEqualToString:@"set"]) {
        if ([b[@"items"] isKindOfClass:[NSDictionary class]]) [self storeSet:b[@"items"]];
        return;
    }
    if ([op isEqualToString:@"remove"]) {
        NSMutableDictionary *ch = [NSMutableDictionary dictionary];
        NSArray *keys = [b[@"keys"] isKindOfClass:[NSArray class]] ? b[@"keys"] : @[];
        for (id k in keys) {
            if (![k isKindOfClass:[NSString class]]) continue;
            SCMCSet(k, nil);
            ch[k] = @{ @"newValue": [NSNull null] };
        }
        [self broadcast:ch];
        return;
    }
}

- (void)handleUIAction:(NSString *)a {
    if ([a isEqualToString:@"open-settings"]) [self showOptions];
    else if ([a isEqualToString:@"close"] || [a isEqualToString:@"close-options"]) [self showApp];
    else if ([a isEqualToString:@"back"]) [self.webView goBack];
    else if ([a isEqualToString:@"fwd"]) [self.webView goForward];
    else if ([a isEqualToString:@"reload"]) [self sendState];
}

- (NSDictionary *)storeGet:(NSArray *)keys defaults:(NSDictionary *)defs {
    NSMutableDictionary *r = [NSMutableDictionary dictionary];
    for (id k in keys ?: @[]) {
        if (![k isKindOfClass:[NSString class]]) continue;
        id v = SCMCGet(k);
        if (v) r[k] = v;
        else if (defs[k]) r[k] = defs[k];
    }
    return r;
}

- (void)evalOnMain:(NSString *)js {
    dispatch_async(dispatch_get_main_queue(), ^{ [self.webView evaluateJavaScript:js completionHandler:nil]; });
}

- (void)broadcast:(NSDictionary *)changes {
    NSString *j = SCMCJSONString(changes, nil);
    if (!j) return;
    [self evalOnMain:[NSString stringWithFormat:@"window.__sccStorageChanged && window.__sccStorageChanged(%@);", j]];
}

- (void)storeSet:(NSDictionary *)items {
    NSMutableDictionary *ch = [NSMutableDictionary dictionary];
    [items enumerateKeysAndObjectsUsingBlock:^(id k, id v, BOOL *stop) {
        if (![k isKindOfClass:[NSString class]]) return;
        if (![NSJSONSerialization isValidJSONObject:@{ @"v": v ?: [NSNull null] }]) return;
        SCMCSet(k, v);
        ch[k] = @{ @"newValue": v ?: [NSNull null] };
    }];
    [self broadcast:ch];
}

// Ответ адресуется по id запроса: несколько параллельных get() больше не затирают друг друга.
- (void)reply:(NSDictionary *)obj forId:(id)rid {
    if (![rid isKindOfClass:[NSString class]]) return;
    NSString *safe = [[(NSString *)rid componentsSeparatedByCharactersInSet:[[NSCharacterSet alphanumericCharacterSet] invertedSet]] componentsJoinedByString:@""];
    [self evalOnMain:[NSString stringWithFormat:@"window.__sccNativeReply && window.__sccNativeReply('%@',%@);", safe, SCMCJSONString(obj, @"{}")]];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation { [self sendState]; }
@end

#pragma mark - Overlay injection

static SCMCBridge *gBridge;

static void SCMCBuildOverlay(UIWindow *w) {
    UIView *host = [[SCMCPassthroughView alloc] initWithFrame:w.bounds];
    host.backgroundColor = UIColor.clearColor;
    host.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;

    WKWebViewConfiguration *cfg = [WKWebViewConfiguration new];
    cfg.allowsInlineMediaPlayback = YES;
    cfg.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
    SCMCBridge *bridge = [SCMCBridge new];
    WKUserContentController *ucc = [WKUserContentController new];
    [ucc addScriptMessageHandler:bridge name:@"sccNative"];
    cfg.userContentController = ucc;

    SCMCPassthroughWebView *wv = [[SCMCPassthroughWebView alloc] initWithFrame:host.bounds configuration:cfg];
    wv.backgroundColor = UIColor.clearColor;
    wv.opaque = NO;
    wv.scrollView.backgroundColor = UIColor.clearColor;
    wv.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    wv.navigationDelegate = bridge;
    wv.interactive = NO;
    bridge.webView = wv;
    [host addSubview:wv];

    UIButton *fab = [UIButton buttonWithType:UIButtonTypeSystem];
    fab.frame = CGRectMake(w.bounds.size.width - 68, w.bounds.size.height * 0.62, 52, 52);
    fab.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin | UIViewAutoresizingFlexibleTopMargin;
    fab.layer.cornerRadius = 26;
    fab.backgroundColor = [UIColor colorWithWhite:0.12 alpha:0.92];
    fab.tintColor = [UIColor colorWithRed:1 green:.33 blue:.08 alpha:1];
    [fab setTitle:@"☷" forState:UIControlStateNormal];
    fab.titleLabel.font = [UIFont systemFontOfSize:28 weight:UIFontWeightSemibold];
    [fab addTarget:bridge action:@selector(openCustomizer) forControlEvents:UIControlEventTouchUpInside];
    [host addSubview:fab];
    bridge.fab = fab;

    [w addSubview:host];
    gBridge = bridge;
    gOverlay = host;
    SCMCLog(@"overlay built (window %@)", NSStringFromClass([w class]));
}

// Вызывается только на главном потоке. Если окна ещё нет (старт приложения), пробуем снова —
// раньше единственная попытка делалась в момент DidFinishLaunching, когда окна обычно ещё нет.
static void SCMCTryShowOverlay(int attempt) {
    UIWindow *w = SCMCActiveWindow();
    if (!w) {
        if (attempt < 120) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                SCMCTryShowOverlay(attempt + 1);
            });
        }
        return;
    }
    if (!gOverlay) SCMCBuildOverlay(w);
    else if (gOverlay.superview != w) { [gOverlay removeFromSuperview]; gOverlay.frame = w.bounds; [w addSubview:gOverlay]; }
    else [w bringSubviewToFront:gOverlay];
    [gBridge sendState];
}

void SCMCNativeInstallMarker(void) {}

@implementation SCMCNative
+ (void)install {
    dispatch_async(dispatch_get_main_queue(), ^{ SCMCTryShowOverlay(0); });
}
@end
