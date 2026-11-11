import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/models/conversation_models.dart';
import 'package:soduwork_mobile/ui/cloud_conversation_timeline.dart';
import 'package:soduwork_mobile/ui/cloud_conversation_controls.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  for (final width in [320.0, 390.0]) {
    testWidgets(
      'short conversation starts at the top and reasoning is collapsed at $width',
      (tester) async {
        tester.view.physicalSize = Size(width, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final scroll = ScrollController();
        addTearDown(scroll.dispose);
        await tester.pumpWidget(
          MaterialApp(
            theme: SoduWorkTheme.light(),
            home: Scaffold(
              body: CloudConversationTimeline(
                controller: scroll,
                events: [
                  ConversationEvent.fromJson({
                    'seq': 1,
                    'kind': 'user',
                    'text': '你好',
                  }),
                  ConversationEvent.fromJson({
                    'seq': 2,
                    'kind': 'step',
                    'text': '第 1 步 · 正在想…',
                  }),
                  ConversationEvent.fromJson({
                    'seq': 3,
                    'kind': 'thinking',
                    'text': '供用户主动展开的思考内容',
                  }),
                  ConversationEvent.fromJson({
                    'seq': 4,
                    'kind': 'say',
                    'text': '你好，准备好开始工作了。',
                  }),
                ],
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.getTopLeft(find.text('你好')).dy, lessThan(80));
        expect(find.text('供用户主动展开的思考内容'), findsNothing);
        expect(find.text('第 1 步 · 正在想…'), findsNothing);
        expect(find.text('你好，准备好开始工作了。'), findsOneWidget);
        await tester.tap(find.text('思考过程'));
        await tester.pumpAndSettle();
        expect(find.text('供用户主动展开的思考内容'), findsOneWidget);
        expect(find.byTooltip('复制回答'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'conversation input uses neutral action and switches stop to send with text',
    (tester) async {
      final input = TextEditingController(), focus = FocusNode();
      addTearDown(input.dispose);
      addTearDown(focus.dispose);
      var sends = 0, stops = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoduWorkTheme.light(),
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: CloudConversationComposer(
                controller: input,
                focusNode: focus,
                enabled: true,
                busy: false,
                running: true,
                hint: '与 SoduWork 协作',
                onSend: () => sends++,
                onStop: () => stops++,
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byTooltip('停止生成'));
      expect(stops, 1);
      await tester.enterText(
        find.byKey(const Key('conversation-input')),
        '继续处理',
      );
      await tester.pump();
      final button = tester.widget<IconButton>(
        find
            .ancestor(
              of: find.byIcon(CupertinoIcons.arrow_up),
              matching: find.byType(IconButton),
            )
            .first,
      );
      final color = button.style!.backgroundColor!.resolve({})!;
      expect((color.r - color.g).abs(), lessThan(.04));
      expect((color.g - color.b).abs(), lessThan(.04));
      expect(find.byIcon(CupertinoIcons.arrow_up), findsOneWidget);
      await tester.tap(find.byTooltip('发送'));
      expect(sends, 1);
    },
  );
}
