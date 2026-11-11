import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('commercial package carries an offline simplified Chinese font', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final font = File('assets/fonts/NotoSansSC-Variable.ttf');
    final license = File('assets/fonts/OFL-NotoSansSC.txt');

    expect(pubspec, contains('family: Noto Sans SC'));
    expect(pubspec, contains('assets/fonts/NotoSansSC-Variable.ttf'));
    expect(font.existsSync(), isTrue);
    expect(font.lengthSync(), greaterThan(16 * 1024 * 1024));
    final handle = font.openSync();
    final signature = handle.readSync(4);
    handle.closeSync();
    expect(signature, equals([0x00, 0x01, 0x00, 0x00]));
    expect(license.existsSync(), isTrue);
    expect(license.readAsStringSync(), contains('SIL OPEN FONT LICENSE'));
  });
}
