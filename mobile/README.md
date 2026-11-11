# Android client

[简体中文](README.zh-CN.md) · **English** · [Documentation](../docs/README.md)

This Flutter source corresponds to Client 1.13.13 (build 17). It includes the
Android host, application, tests, bundled conversation assets and their notices.
Private deployment tools and local environment configuration are excluded.

Use Flutter 3.47.7 with its bundled Dart SDK, Java 17 and the Android SDK.
Dependencies come from pub.dev, Google Maven, Maven Central and the official
Gradle distribution. Run these commands from the `mobile/` directory:

```sh
flutter pub get --enforce-lockfile
flutter analyze
flutter test
```

The GitHub workflows build with `SODUWORK_HUB_URL=https://service.soduwork.ai`
and enable the bundled Android conversation view. Release builds require a
keystore via `android/key.properties`; never commit that file or a signing key.

`Native package validation` generates a disposable test key, builds the APK,
installs it in an emulator, and retains only a checksum report. It does not publish
an APK or authorize production updates. `Public release` requires the maintained
Android signing secrets and the repository's public distribution approval.

macOS desktop packages come from the Electron client, not this Flutter project.
