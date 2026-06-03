# Android Release Build — Signed .aab

The signing config is already wired into `android/app/build.gradle`. It reads
credentials from `android/keystore.properties` (gitignored — never committed).

## One-time files (already created locally, NOT in git)
- `android/keystore.properties`
  ```
  storeFile=speakergym-release-key.jks
  storePassword=********
  keyAlias=key0
  keyPassword=********
  ```
- `android/speakergym-release-key.jks`  (copy of your Desktop keystore)

## Build the signed bundle (run on a machine with Android SDK + JDK 17)
```bash
# from project root
npx cap sync android        # sync latest web assets into the native project
cd android
./gradlew :app:bundleRelease
```

## Output
```
android/app/build/outputs/bundle/release/app-release.aab
```
This .aab is signed with key0 and ready to upload to the Play Console.
Do NOT use the APK (`assembleRelease`) for Play Store — the .aab is required.

## Notes
- `gradlew` line endings were normalized to LF.
- versionCode=1, versionName=1.0 in `android/app/build.gradle` — bump versionCode
  for each new Play upload.
