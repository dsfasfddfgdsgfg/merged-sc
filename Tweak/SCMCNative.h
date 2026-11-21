#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <AVFoundation/AVFoundation.h>
#import <MediaPlayer/MediaPlayer.h>

void SCMCNativeInstallMarker(void);
/// YES только для первой загруженной копии твика в процессе (защита от двойной инъекции).
BOOL SCMCClaimProcess(void);
void SCMCInstallEQForPlayerItem(AVPlayerItem *item);
BOOL SCMCAudioMixIsOurs(AVAudioMix *mix);

@interface SCMCNative : NSObject
+ (void)install;
@end
