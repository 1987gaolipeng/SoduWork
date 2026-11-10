import 'dart:ui' show SemanticsAction;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/ui/conversation_markdown.dart';
import 'package:soduwork_mobile/ui/cloud_conversation_messages.dart';
import 'package:soduwork_mobile/models/conversation_models.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

Widget harness(String data, {Future<bool> Function(Uri)? openLink}) =>
    MaterialApp(
      theme: SoduWorkTheme.light(),
      home: Scaffold(
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: ConversationMarkdown(data: data, openLink: openLink),
        ),
      ),
    );

void main() {
  testWidgets('cloud assistant events use the same Markdown renderer', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SoduWorkTheme.light(),
        home: Scaffold(
          body: CloudConversationEventTile(
            event: ConversationEvent.fromJson({
              'seq': 1,
              'kind': 'say',
              'text': '## 云端正文\n\n```dart\nprint(1);\n```',
            }),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(ConversationMarkdown), findsOneWidget);
    expect(find.byType(MarkdownBody), findsOneWidget);
    expect(find.text('云端正文'), findsOneWidget);
    expect(find.byTooltip('复制代码'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  test('only ordinary HTTP(S) URLs without credentials can be opened', () {
    for (final value in [
      'file:///private/report.txt',
      'javascript:alert(1)',
      'data:text/html,hello',
      '//example.com',
      'https://name:secret@example.com',
      'https://example.com/\nunsafe',
      'https://',
    ]) {
      expect(ConversationMarkdown.safeLink(value), isNull, reason: value);
    }
    expect(
      ConversationMarkdown.safeLink('https://example.com/report?q=hello')?.host,
      'example.com',
    );
    expect(
      ConversationMarkdown.safeLink('http://127.0.0.1:18891/')?.port,
      18891,
    );
  });

  testWidgets(
    'GFM renders headings lists quotes and tables within 320 pixels',
    (tester) async {
      tester.view.physicalSize = const Size(320, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        harness(
          '# 工作成果\n\n> 保留完整依据\n\n- 已完成\n- 等待验收\n\n'
          '| 非常长的第一列表头 | 第二列完整内容 | 第三列 |\n'
          '| --- | --- | --- |\n'
          '| 不应截断的表格内容 | 需要横向滚动查看的较长内容 | 保留内容 |',
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('工作成果'), findsOneWidget);
      expect(find.text('保留完整依据'), findsOneWidget);
      expect(find.byType(Table), findsOneWidget);
      final horizontal = find.byWidgetPredicate(
        (widget) =>
            widget is SingleChildScrollView &&
            widget.scrollDirection == Axis.horizontal,
      );
      expect(horizontal, findsOneWidget);
      await tester.drag(horizontal, const Offset(-200, 0));
      await tester.pump();
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'long unclosed code fences stay horizontally scrollable and copy complete text',
    (tester) async {
      tester.view.physicalSize = const Size(320, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final code = 'final message = "${List.filled(60, '完整内容').join()}";';
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await tester.pumpWidget(harness('```dart\n$code'));
      await tester.pumpAndSettle();
      expect(find.textContaining('final message'), findsOneWidget);
      expect(find.byTooltip('复制代码'), findsOneWidget);
      await tester.tap(find.byTooltip('复制代码'));
      await tester.pumpAndSettle();
      expect(copied?.trimRight(), code);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'every image URI stays a placeholder and never creates Image widgets',
    (tester) async {
      await tester.pumpWidget(
        harness(
          '![网络图片](https://example.com/private.png)\n\n'
          '![本机文件](file:///private/image.png)\n\n'
          '![内嵌图片](data:image/png;base64,AAAA)',
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsNothing);
      expect(find.text('图片未自动加载：网络图片'), findsOneWidget);
      expect(find.text('图片未自动加载：本机文件'), findsOneWidget);
      expect(find.text('图片未自动加载：内嵌图片'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'links require a user click and confirmation before the launcher runs',
    (tester) async {
      final opened = <Uri>[];
      await tester.pumpWidget(
        harness(
          '[查看报告](https://example.com/report)',
          openLink: (uri) async {
            opened.add(uri);
            return true;
          },
        ),
      );
      await tester.pumpAndSettle();
      expect(opened, isEmpty);
      await tester.tap(find.text('查看报告', findRichText: true));
      await tester.pumpAndSettle();
      expect(opened, isEmpty);
      expect(find.text('打开外部链接'), findsOneWidget);
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(opened, isEmpty);
      await tester.tap(find.text('查看报告', findRichText: true));
      await tester.pumpAndSettle();
      await tester.tap(find.text('打开链接'));
      await tester.pumpAndSettle();
      expect(opened.single.toString(), 'https://example.com/report');
    },
  );

  testWidgets('unsafe link callbacks cannot launch executable or local URIs', (
    tester,
  ) async {
    var opens = 0;
    await tester.pumpWidget(
      harness(
        '[本机文件](file:///private/report)',
        openLink: (_) async {
          opens++;
          return true;
        },
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('本机文件', findRichText: true));
    await tester.pumpAndSettle();
    expect(opens, 0);
    expect(find.text('此链接不支持安全打开'), findsOneWidget);
  });

  testWidgets(
    'real semantics retain all prose and accessible code copy controls',
    (tester) async {
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        harness('## 成果标题\n\n完整正文第一段。\n\n完整正文第二段。\n\n```text\n完整代码内容\n```'),
      );
      await tester.pumpAndSettle();
      expect(find.bySemanticsLabel('成果标题'), findsOneWidget);
      expect(find.bySemanticsLabel('完整正文第一段。'), findsOneWidget);
      expect(find.bySemanticsLabel('完整正文第二段。'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('完整代码内容')), findsOneWidget);
      final copySemantics = tester
          .getSemantics(find.byTooltip('复制代码'))
          .getSemanticsData();
      expect(copySemantics.tooltip, '复制代码');
      expect(copySemantics.hasAction(SemanticsAction.tap), isTrue);
      expect(find.byType(SelectionArea), findsOneWidget);
      expect(find.byType(MarkdownBody), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
      semantics.dispose();
    },
  );
}
