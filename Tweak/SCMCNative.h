#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <AVFoundation/AVFoundation.h>
#import <MediaPlayer/MediaPlayer.h>

void SCMCNativeInstallMarker(void);
/// YES только для первой загруженной копии твика в процессе (защита от двойной инъекции).
BOOL SCMCClaimProcess(void);
/// Журнал в Documents/scmc.log (виден в приложении «Файлы»).
void SCMCLog(NSString *fmt, ...);
/// Возвращает «безопасный уровень» 0–3 (см. SCMCNative.m).
int SCMCBeginLaunch(void);
/// Запасная папка вместо App Group, которой нет после переподписи приложения.
NSURL *SCMCFallbackGroupURL(NSString *groupId);
void SCMCInstallEQForPlayerItem(AVPlayerItem *item);
BOOL SCMCAudioMixIsOurs(AVAudioMix *mix);

@interface SCMCNative : NSObject
+ (void)install;
@end
