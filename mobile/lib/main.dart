import 'package:flutter/material.dart';

import 'mobile_app.dart';
import 'sdk/soduwork_sdk_config.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // The standalone app keeps one installation identity and lets its owner
  // select a different Hub. Enterprise SDK hosts may still lock their endpoint.
  runApp(
    const SoduWorkMobileApp(
      configuration: SoduWorkSdkConfiguration(lockServiceEndpoint: false),
    ),
  );
}
