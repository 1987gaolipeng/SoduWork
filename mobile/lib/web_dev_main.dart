import 'package:flutter/material.dart';

import 'mobile_app.dart';
import 'sdk/soduwork_sdk_config.dart';

/// Explicit development target. The loopback gateway selects the fixed Hub.
/// First visits remain signed out; existing device sessions resume on reload.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    SoduWorkMobileApp(
      configuration: SoduWorkSdkConfiguration(
        autoConnect: false,
        restoreSavedSession: true,
        serviceBaseUrl: Uri.base.origin,
        serviceDisplayName: switch (Uri.base.port) {
          18890 => 'work.example.com',
          18893 => '本机独立测试',
          18899 => '跨端分支测试 · 4a611400',
          _ => '',
        },
        lockServiceEndpoint: true,
        deviceDisplayName: 'SoduWork Web 联调',
      ),
    ),
  );
}
