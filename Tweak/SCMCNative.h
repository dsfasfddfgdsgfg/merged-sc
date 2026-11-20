#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <AVFoundation/AVFoundation.h>
#import <MediaPlayer/MediaPlayer.h>

void SCMCNativeInstallMarker(void);
void SCMCInstallEQForPlayerItem(AVPlayerItem *item);
@interface SCMCNative : NSObject
+ (void)install;
@end
