# SCMusicPlus Customizer

This tree merges the existing waruhachi SCMusicPlus tweak with the supplied Customizer for SoundCloud UI.

## Architecture

- The target remains the real `com.soundcloud.TouchApp` application.
- SCMusicPlus's existing ad/promoted/upsell hooks are retained.
- The Customizer UI is loaded as a transparent `WKWebView` overlay from `SCMusicPlus.bundle` inside SoundCloud; it is not a separate app and it does not open soundcloud.com as the main application.
- The floating button, menu, full-screen player, settings UI and EQ UI come from the supplied Customizer sources.
- Settings are persisted in the SoundCloud process through the tweak bridge.
- The EQ is native: a 7-band biquad chain is attached to `AVPlayerItem` audio tracks through `MTAudioProcessingTap`. This is intentionally separate from the browser `AudioContext` implementation in the original web wrapper.

## Important build note

Workflow **Build SoundCloud IPA** (`.github/workflows/build-ipa.yml`, manual run) builds the tweak and injects it into a decrypted SoundCloud IPA with cyan. The base IPA is not included: pass a direct link in `ipa_url`, or upload it once as an asset to a release with tag `base-ipa` and leave the field empty. Result: artifact `SoundCloud-Customizer-ipa` (unsigned, sign with AltStore/Sideloadly). `build.yml` (DEB packages for jailbreak) is manual-only now.

## Version compatibility

The native hook for the equalizer depends on SoundCloud continuing to use `AVPlayerItem` for the relevant audio path. If a future SoundCloud build changes its playback stack, the EQ hook may need a version-specific adjustment.

## Changelog v2 (fix: приложение не запускалось)

Сборка / база IPA
- Новый шаг workflow `Sanitize base IPA`: скрипт очистки (встроен прямо в `build-ipa.yml`) вычищает из базового IPA чужие моды
  (Substrate/ElleKit/libhooker, старые копии SCMusicPlus, в режиме `strip_extra` (по умолчанию вкл.) — любые посторонние
  dylib) и вырезает висячие/удалённые load-команды из главного бинарника. Отчёт — в Summary запуска и артефакт `sanitize-report`.
- После инъекции проверяется: SCMusicPlus подключён ровно 1 раз, hook-библиотека (Substrate/ElleKit) — не более одной.
- `MediaToolbox` добавлен в `FRAMEWORKS` (нужен для MTAudioProcessingTap).

Нативный код
- Оверлей: контейнер больше не перехватывает все касания (раньше всё приложение «зависало»); окно ищется с повторными
  попытками (раньше единственная попытка на DidFinishLaunching, когда окна ещё нет, и оверлей не создавался никогда).
- Эквалайзер: убрана бесконечная рекурсия `setAudioMix:`; треки грузятся асинхронно (нет блокировки главного потока);
  в аудио-потоке больше нет Objective-C/NSUserDefaults; поддерживается только float32 PCM, иначе проходной режим.
  Ограничение: тап не работает на HLS-потоках; EQ включается со следующего трека.
- Настройки хранятся в `Application Support/SCMusicPlus/store.json`, а не в NSUserDefaults SoundCloud
  (старые ключи `SCMC.*` переносятся автоматически).
- Страница настроек открывается (`Web/ext/options.html`, подключён `native-bridge.js`, доступ на чтение — ко всему бандлу).
- Мост хранилища: ответы адресуются по id — параллельные `get()` не зависают.
- JSON в мост/из моста проверяется `isValidJSONObject` (NaN/Inf раньше роняли приложение исключением).
- Защита от двойной загрузки твика в одном процессе; один `%ctor` вместо двух.
- Удалена устаревшая папка `Resources/` (копия бандла, в сборку не входила).

## Changelog v3 (приложение закрывалось сразу после запуска / зависало)

- Самодиагностика: твик пишет журнал `Documents/scmc.log` (приложение «Файлы» → На iPhone → SoundCloud; workflow включает
  файловый доступ в Info.plist) и записывает в него причину падения (исключение или сигнал + стек).
- «Безопасные уровни»: если прошлый запуск умер, не прожив 10 секунд, следующий автоматически отключает часть функций:
  1 — оверлей и эквалайзер, 2 — ещё и хуки Foundation/сети/подмены версии, 3 — все хуки. Текущий уровень в
  `Documents/scmc-level.txt` (формат `уровень,флаг`); удалите файл, чтобы сбросить уровень на 0.
- Очистка базового IPA больше не трогает заплатку `sideloadKeychainFix` (это не мод, а фикс связки ключей для сайдлоада).
- Опрос «что играет» (каждые 0.5 с) больше не обходит все вью SoundCloud и не кодирует обложку на главном потоке:
  обложка кодируется один раз на трек в фоне (раньше — основная причина «намертво зависает» после открытия меню).

## Changelog v4 (реальная причина: крэш-лог)

- Крэш-лог показал падение самого SoundCloud (не твика): Swift trap во фреймворке `SCData`, в `dispatch_once` на стартовой
  очереди, ~4 с после запуска (в регистрах `URL` и `NSFileManager`). Причина — после переподписи пропала App Group, и
  `containerURLForSecurityApplicationGroupIdentifier:` возвращает nil, который приложение разворачивает принудительно.
- Фикс: хук `NSFileManager` (группа `CompatHooks`, включена на любом безопасном уровне) подставляет папку в песочнице
  приложения (`Application Support/SCMC-AppGroups/<id>`), если системная группа недоступна. Факт подмены пишется в `scmc.log`.
