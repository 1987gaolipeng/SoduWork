import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:soduwork_mobile/ui/conversation_markdown.dart';
import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/artifact_download.dart';
import 'package:soduwork_mobile/core/mobile_library.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/library_screen.dart';
import 'package:soduwork_mobile/screens/library_item_screen.dart';
import 'package:soduwork_mobile/screens/library_note_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/library_actions.dart';
import 'package:soduwork_mobile/ui/artifact_actions.dart';
import 'package:soduwork_mobile/ui/library_file_menu.dart';
import 'memory_device_auth.dart';

http.Response reply(Object value, [int status = 200]) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

class Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'session';
}

class StateFixture extends MobileState {
  int revision = 0;
  @override
  int get identityRevision => revision;
  void change() {
    revision++;
    notifyListeners();
  }
}

SoduWorkApi apiFor(Future<http.Response> Function(http.Request) handler) =>
    SoduWorkApi(
      store: Store(),
      endpoint: const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'https://hub.test',
      ),
      client: MockClient(handler),
    );
Future<StateFixture> showPage(
  WidgetTester tester,
  Widget page,
  SoduWorkApi api,
) async {
  tester.view.physicalSize = const Size(390, 1000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final state = StateFixture()..api = api;
  addTearDown(state.dispose);
  addTearDown(api.client.close);
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(home: Scaffold(body: page)),
    ),
  );
  await tester.pumpAndSettle();
  return state;
}

void main() {
  testWidgets('only the file region scrolls in list and grid views', (
    tester,
  ) async {
    await showPage(
      tester,
      const LibraryScreen(
        initialLocation: LibraryLocation(storage: 'nfs', label: '远程存储'),
      ),
      apiFor(
        (_) async => reply({
          'ok': true,
          'items': List.generate(
            60,
            (i) => {'id': 'id-$i', 'filename': 'file-$i.txt'},
          ),
          'folders': [],
        }),
      ),
    );
    for (final grid in [false, true]) {
      if (grid) {
        await tester.tap(find.byTooltip('切换为网格视图'));
        await tester.pumpAndSettle();
      }
      final results = find.byType(ListView);
      final scroll = tester
          .state<ScrollableState>(
            find
                .descendant(of: results, matching: find.byType(Scrollable))
                .first,
          )
          .position;
      scroll.jumpTo(0);
      await tester.pumpAndSettle();
      final search = tester.getRect(find.byType(TextField));
      final filters = tester.getRect(find.widgetWithText(ChoiceChip, '推荐'));
      expect(
        tester.getRect(results).top - filters.bottom,
        greaterThanOrEqualTo(16),
      );
      await tester.drag(results, const Offset(0, -260));
      await tester.pumpAndSettle();
      expect(scroll.pixels, greaterThan(0));
      expect(tester.getRect(find.byType(TextField)), search);
      expect(tester.getRect(find.widgetWithText(ChoiceChip, '推荐')), filters);
    }
  });
  testWidgets(
    'tapping a library row opens its authenticated Markdown preview with download',
    (tester) async {
      final item = {
        'id': 'md-1',
        'filename': '说明.md',
        'contentType': 'text/markdown',
      };
      var reads = 0;
      await showPage(
        tester,
        const LibraryScreen(
          initialLocation: LibraryLocation(storage: 'nfs', label: '远程存储'),
        ),
        apiFor((r) async {
          if (r.url.path.endsWith('/md-1/content')) {
            reads++;
            return reply({'ok': true, 'item': item, 'content': '# 单击打开'});
          }
          return reply({
            'ok': true,
            'items': [item],
            'folders': [],
          });
        }),
      );
      await tester.tap(find.text('说明.md'));
      await tester.pumpAndSettle();
      expect(reads, 1);
      expect(
        tester
            .widget<ConversationMarkdown>(find.byType(ConversationMarkdown))
            .data,
        '# 单击打开',
      );
      expect(find.byTooltip('下载文件'), findsOneWidget);
    },
  );
  testWidgets(
    'compact toolbar keeps create, views and trash reachable on a narrow phone',
    (tester) async {
      final scopes = <String?>[];
      await showPage(
        tester,
        const LibraryScreen(
          initialLocation: LibraryLocation(storage: 'nfs', label: '远程存储'),
        ),
        apiFor((r) async {
          scopes.add(r.url.queryParameters['scope']);
          return reply({
            'ok': true,
            'items': [
              {'id': 'one', 'filename': 'file.txt'},
            ],
            'folders': [],
          });
        }),
      );
      tester.view.physicalSize = const Size(320, 720);
      await tester.pumpAndSettle();
      final search = tester.getRect(find.byType(TextField));
      final create = tester.getRect(find.byTooltip('新建'));
      expect(create.left, greaterThanOrEqualTo(search.right));
      expect(create.center.dy, closeTo(search.center.dy, 1));
      expect(search.height, lessThanOrEqualTo(48));
      expect(find.text('回收站'), findsNothing);
      await tester.tap(find.byTooltip('新建'));
      await tester.pumpAndSettle();
      expect(find.text('上传文件'), findsOneWidget);
      await tester.tapAt(const Offset(4, 4));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('切换为网格视图'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('切换为列表视图'), findsOneWidget);
      await tester.tap(find.byTooltip('切换为列表视图'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('筛选与显示'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('回收站'));
      await tester.pumpAndSettle();
      expect(scopes.last, 'trash');
      expect(find.byTooltip('新建'), findsNothing);
      await tester.tap(find.text('推荐'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('新建'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'Android and iOS save bytes by the original name through the system file dialog',
    (tester) async {
      const channel = MethodChannel('flutter_file_dialog');
      final messenger = tester.binding.defaultBinaryMessenger;
      MethodCall? captured;
      messenger.setMockMethodCallHandler(channel, (call) async {
        captured = call;
        return null;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final artifact = DownloadedArtifact(
        bytes: Uint8List.fromList([1, 2]),
        filename: '提示词.txt',
        contentType: 'text/plain',
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => exportMobileFile(context, artifact),
              child: const Text('保存测试'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('保存测试'));
      await tester.pumpAndSettle();
      expect(captured?.method, 'saveFile');
      expect(captured?.arguments['fileName'], '提示词.txt');
      expect(captured?.arguments['data'], orderedEquals([1, 2]));
    },
    variant: TargetPlatformVariant({
      TargetPlatform.android,
      TargetPlatform.iOS,
    }),
    skip: kIsWeb,
  );
  testWidgets(
    'opening a text file previews bytes before any system action and hides them on account change',
    (tester) async {
      final file = DownloadedArtifact(
        bytes: Uint8List.fromList(utf8.encode('测试文件正文')),
        filename: '提示词.txt',
        contentType: 'application/octet-stream',
      );
      final state = await showPage(
        tester,
        Builder(
          builder: (context) => TextButton(
            onPressed: () =>
                exportMobileFile(context, file, openOnDevice: true),
            child: const Text('打开测试文件'),
          ),
        ),
        apiFor((_) async => reply({})),
      );
      await tester.tap(find.text('打开测试文件'));
      await tester.pumpAndSettle();
      expect(find.text('测试文件正文'), findsOneWidget);
      expect(find.text('系统分享或打开'), findsOneWidget);
      state.change();
      await tester.pumpAndSettle();
      expect(find.text('测试文件正文'), findsNothing);
      expect(find.text('系统分享或打开'), findsNothing);
    },
  );

  testWidgets(
    'failed text save retains editable draft and acknowledged retry closes',
    (tester) async {
      var attempts = 0;
      String? saved;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async {
                  saved = await editLibraryText(
                    context,
                    'original',
                    save: (value) async {
                      attempts++;
                      expect(value, 'mobile draft');
                      if (attempts == 1) throw const ApiFailure('电脑暂时离线');
                    },
                  );
                },
                child: const Text('编辑测试'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('编辑测试'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'mobile draft');
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(find.textContaining('电脑暂时离线'), findsOneWidget);
      expect(find.text('mobile draft'), findsOneWidget);
      expect(saved, isNull);
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(saved, 'mobile draft');
      expect(attempts, 2);
      expect(find.text('编辑测试'), findsOneWidget);
    },
  );

  testWidgets(
    'library starts on the ready PC and refuses unavailable remote or offline targets',
    (tester) async {
      final nativeCalls = <Map<String, dynamic>>[];
      final serverQueries = <Map<String, String>>[];
      await showPage(
        tester,
        const LibraryScreen(),
        apiFor((r) async {
          if (r.url.path.endsWith('/targets')) {
            return reply({
              'items': [
                {
                  'id': 'pc-ready',
                  'name': '我的电脑',
                  'ready': true,
                  'libraryReady': true,
                },
                {
                  'id': 'pc-offline',
                  'name': '离线电脑',
                  'ready': false,
                  'libraryReady': true,
                },
              ],
            });
          }
          if (r.url.path.endsWith('/storage/status')) {
            return reply({
              'remote': {
                'available': true,
                'connected': false,
                'backend': 'minio',
              },
            });
          }
          if (r.url.path.endsWith('/requests')) {
            nativeCalls.add(Map<String, dynamic>.from(jsonDecode(r.body)));
            expect(r.url.path, contains('/pc-ready/'));
            return reply({
              'ok': true,
              'items': [
                {
                  'id': 'pc-file',
                  'title': '本机资料',
                  'filename': 'note.txt',
                  'format': 'txt',
                },
              ],
              'folders': [],
            });
          }
          serverQueries.add(r.url.queryParameters);
          return reply({
            'ok': true,
            'items': [
              {'id': 'server-file', 'filename': 'server-note.txt'},
            ],
            'folders': [],
          });
        }),
      );
      expect(find.text('本机资料.txt'), findsOneWidget);
      expect(serverQueries, isEmpty);
      expect(find.text('本地存储'), findsOneWidget);
      expect(find.text('我的电脑'), findsOneWidget);
      await tester.tap(find.text('切换'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<ListTile>(find.widgetWithText(ListTile, '离线电脑')).enabled,
        isFalse,
      );
      expect(
        tester
            .widget<ListTile>(find.widgetWithText(ListTile, '远程存储未连接'))
            .enabled,
        isFalse,
      );
      await tester.tap(find.widgetWithText(ListTile, '我的电脑'));
      await tester.pumpAndSettle();
      expect(find.text('本机资料.txt'), findsOneWidget);
      expect(nativeCalls, hasLength(2));
      expect(
        nativeCalls.every((r) => r['operation'] == 'library.call'),
        isTrue,
      );
      expect(serverQueries, isEmpty);
    },
  );

  testWidgets(
    'remote tree keeps historical folders read-only and returns to its concrete backend',
    (tester) async {
      final queries = <Map<String, String>>[];
      await showPage(
        tester,
        const LibraryScreen(
          initialLocation: LibraryLocation(storage: 'nfs', label: '远程存储'),
        ),
        apiFor((r) async {
          queries.add(r.url.queryParameters);
          return reply({
            'ok': true,
            'items': [
              {
                'id': 'test',
                'filename': r.url.queryParameters['storage'] == 'local'
                    ? '旧资料.txt'
                    : '远端资料.txt',
              },
            ],
            'folders': [],
          });
        }),
      );
      await tester.tap(find.text('文件夹'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('历史服务器资料'));
      await tester.pumpAndSettle();
      expect(queries.last['storage'], 'local');
      expect(find.text('旧资料.txt'), findsOneWidget);
      expect(find.byTooltip('新建'), findsNothing);
      await tester.tap(find.text('返回上一级'));
      await tester.pumpAndSettle();
      expect(queries.last['storage'], 'nfs');
      expect(find.byTooltip('新建'), findsOneWidget);
    },
  );
  testWidgets(
    'folders excludes files, opens contents, and returns to folder category',
    (tester) async {
      final requests = <Map<String, String>>[];
      await showPage(
        tester,
        const LibraryScreen(
          initialLocation: LibraryLocation(storage: 'minio', label: '远程存储'),
        ),
        apiFor((r) async {
          requests.add(r.url.queryParameters);
          final inside = r.url.queryParameters['folderId'] == 'folder-a';
          return reply({
            'ok': true,
            'folders': inside
                ? []
                : [
                    {'id': 'folder-a', 'name': '工作资料'},
                  ],
            // Also guard against older services returning files for folders.
            'items': [
              {'id': 'file-a', 'filename': inside ? '目录正文.md' : '根目录.md'},
            ],
          });
        }),
      );
      await tester.tap(find.text('文件夹'));
      await tester.pumpAndSettle();
      expect(requests.last['scope'], 'folders');
      expect(find.text('根目录.md'), findsNothing);
      expect(find.text('工作资料'), findsOneWidget);
      await tester.tap(find.text('工作资料'));
      await tester.pumpAndSettle();
      expect(requests.last['scope'], 'all');
      expect(requests.last['folderId'], 'folder-a');
      expect(find.text('目录正文.md'), findsOneWidget);
      await tester.tap(find.text('返回上一级'));
      await tester.pumpAndSettle();
      expect(requests.last['scope'], 'folders');
      expect(find.text('根目录.md'), findsNothing);
      await tester.tap(find.text('全部'));
      await tester.pumpAndSettle();
      expect(requests.last['scope'], 'all');
      expect(requests.last['folderId'] ?? '', isEmpty);
      expect(find.text('根目录.md'), findsOneWidget);
    },
  );

  testWidgets(
    'library timestamps use local clock and filenames retain extensions',
    (tester) async {
      const timestamp = '2025-11-03T23:30:39+00:00';
      final local = DateTime.parse(timestamp).toLocal();
      await showPage(
        tester,
        const LibraryScreen(
          initialLocation: LibraryLocation(storage: 'minio', label: '远程存储'),
        ),
        apiFor(
          (r) async => reply({
            'ok': true,
            'folders': [],
            'items': [
              {
                'id': 'file-a',
                'title': '联调',
                'filename': '联调.md',
                'updatedAt': timestamp,
                'size': 27,
                'sourceLabel': '上传',
              },
            ],
          }),
        ),
      );
      expect(find.text('联调.md'), findsOneWidget);
      expect(find.text('上传 · 27 B'), findsOneWidget);
      expect(find.textContaining('T23:30:39'), findsNothing);
      final year = local.year == DateTime.now().year ? '' : '${local.year}年';
      expect(
        find.text(
          '$year${local.month}月${local.day}日 '
          '${local.hour.toString().padLeft(2, '0')}:'
          '${local.minute.toString().padLeft(2, '0')}',
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'library error is not an empty list and search query remains encoded',
    (tester) async {
      final queries = <Map<String, String>>[];
      await showPage(
        tester,
        const LibraryScreen(
          initialLocation: LibraryLocation(storage: 'minio', label: '远程存储'),
        ),
        apiFor((r) async {
          queries.add(r.url.queryParameters);
          return reply({'detail': 'storage unavailable'}, 503);
        }),
      );
      expect(find.text('storage unavailable'), findsOneWidget);
      expect(find.text('这里还没有资料'), findsNothing);
      await tester.enterText(find.byType(TextField), '预算 & 人员');
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      expect(queries.last['query'], '预算 & 人员');
    },
  );
  testWidgets(
    'folder navigation carries backend and stale account response is discarded',
    (tester) async {
      final pending = Completer<http.Response>();
      final state = await showPage(
        tester,
        const LibraryScreen(
          initialLocation: LibraryLocation(storage: 'minio', label: '远程存储'),
        ),
        apiFor((r) async {
          if (r.url.queryParameters['folderId'] == 'folder-a') {
            expect(r.url.queryParameters['storage'], 'minio');
            return pending.future;
          }
          return reply({
            'ok': true,
            'items': [],
            'folders': [
              {'id': 'folder-a', 'name': '跨端资料', 'backend': 'minio'},
            ],
          });
        }),
      );
      await tester.tap(find.text('全部'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('跨端资料'));
      await tester.pump();
      state.change();
      await tester.pump();
      pending.complete(
        reply({
          'ok': true,
          'items': [
            {'id': 'private', 'title': '旧账号资料'},
          ],
        }),
      );
      await tester.pumpAndSettle();
      expect(find.text('旧账号资料'), findsNothing);
      expect(find.text('账号或服务已切换，请关闭后重新打开。'), findsOneWidget);
    },
  );
  testWidgets('row menu updates the selected file without opening details', (
    tester,
  ) async {
    var starred = false;
    await showPage(
      tester,
      const LibraryScreen(
        initialLocation: LibraryLocation(storage: 'minio', label: '远程存储'),
      ),
      apiFor((r) async {
        if (r.method == 'PATCH') {
          expect(r.url.path, endsWith('/items/row-b'));
          expect(jsonDecode(r.body), {'favorite': true});
          starred = true;
          return reply({
            'ok': true,
            'item': {'id': 'row-b', 'favorite': true},
          });
        }
        return reply({
          'ok': true,
          'folders': [],
          'items': [
            {'id': 'row-a', 'filename': 'a.txt'},
            {'id': 'row-b', 'filename': 'b.txt', 'favorite': starred},
          ],
        });
      }),
    );
    final menu = find.descendant(
      of: find.widgetWithText(ListTile, 'b.txt'),
      matching: find.byTooltip('更多操作'),
    );
    await tester.tap(menu);
    await tester.pumpAndSettle();
    expect(find.text('下载文件'), findsOneWidget);
    await tester.tap(find.widgetWithText(PopupMenuItem<FileCommand>, '收藏'));
    await tester.pumpAndSettle();
    expect(starred, isTrue);
    expect(find.byType(LibraryItemScreen), findsNothing);
  });

  testWidgets(
    'item favorite applies only acknowledged same item and trash needs confirmation',
    (tester) async {
      final calls = <String>[];
      final item = {
        'id': 'item-one',
        'title': '原件',
        'filename': 'a.md',
        'favorite': false,
      };
      await showPage(
        tester,
        LibraryItemScreen(item: item),
        apiFor((r) async {
          if (r.method == 'GET') {
            expect(r.url.path, endsWith('/content'));
            return reply({'ok': true, 'item': item, 'content': '# 自动预览正文'});
          }
          calls.add(r.method);
          if (r.method == 'PATCH') {
            expect(jsonDecode(r.body), {'favorite': true});
            return reply({
              'ok': true,
              'item': {...item, 'favorite': true},
            });
          }
          expect(r.method, 'DELETE');
          return reply({
            'ok': true,
            'item': {...item, 'isDeleted': true},
          });
        }),
      );
      expect(find.text('预览内容'), findsNothing);
      expect(find.byType(ConversationMarkdown), findsOneWidget);
      expect(find.byTooltip('下载文件'), findsOneWidget);
      Future<void> openMenu() async {
        await tester.tap(find.byTooltip('更多操作'));
        await tester.pumpAndSettle();
      }

      await openMenu();
      await tester.tap(find.text('收藏'));
      await tester.pumpAndSettle();
      await openMenu();
      expect(find.text('取消收藏'), findsOneWidget);
      await tester.tap(find.text('移入回收站'));
      await tester.pumpAndSettle();
      expect(calls, ['PATCH']);
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      await openMenu();
      expect(calls, ['PATCH']);
      await tester.tap(find.text('移入回收站'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认'));
      await tester.pumpAndSettle();
      expect(calls, ['PATCH', 'DELETE']);
      expect(find.text('恢复资料'), findsOneWidget);
    },
  );
  testWidgets(
    'note validation remains editable and uncertain write cannot be repeated',
    (tester) async {
      var writes = 0;
      await showPage(
        tester,
        const LibraryNoteScreen(folderId: 'folder-a', storage: 'minio'),
        apiFor((r) async {
          writes++;
          final body = jsonDecode(r.body);
          expect(body['folderId'], 'folder-a');
          expect(body['storage'], 'minio');
          expect(body['sourceType'], 'library');
          throw http.ClientException('response lost');
        }),
      );
      await tester.ensureVisible(find.text('保存文档'));
      await tester.tap(find.text('保存文档'));
      await tester.pumpAndSettle();
      expect(writes, 0);
      await tester.ensureVisible(find.widgetWithText(TextField, '标题'));
      await tester.enterText(find.widgetWithText(TextField, '标题'), '测试笔记');
      await tester.ensureVisible(find.text('保存文档'));
      await tester.tap(find.text('保存文档'));
      await tester.pumpAndSettle();
      expect(writes, 1);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '保存文档'))
            .onPressed,
        isNull,
      );
      expect(find.text('保存结果未确认，请先返回资料库刷新核对，避免重复创建。'), findsOneWidget);
    },
  );
  test(
    'library and skill download stay authenticated, checksum-bound and reject redirects',
    () async {
      var calls = 0;
      final api = apiFor((r) async {
        calls++;
        expect(r.headers['Authorization'], 'Device session');
        if (calls == 1) {
          expect(r.url.path, '/api/v1/library/items/item-one/download');
          return http.Response(
            'file',
            200,
            headers: {
              'content-disposition': 'attachment; filename="../safe.txt"',
            },
          );
        }
        expect(r.url.path, '/api/v1/skills/office/download');
        expect(r.url.queryParameters, {
          'checksum': 'version-one',
          'path': 'references/a b.md',
        });
        return http.Response(
          '',
          302,
          headers: {'location': 'https://other.test/file'},
        );
      });
      addTearDown(api.client.close);
      final downloader = ArtifactDownloader(api);
      expect(
        (await downloader.downloadLibrary(
          'item-one',
          filename: 'fallback',
        )).filename,
        'safe.txt',
      );
      await expectLater(
        downloader.downloadSkill('office', 'version-one', 'references/a b.md'),
        throwsA(isA<ApiFailure>()),
      );
      expect(calls, 2);
    },
  );
}
