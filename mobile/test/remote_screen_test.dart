import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/state/remote_screen_controller.dart';
import 'package:soduwork_mobile/state/remote_screen_transport.dart';

class Connection implements RemoteScreenConnection {
  final events = StreamController<Object>();
  final sent = <String>[];
  bool closed = false;
  @override
  Stream<Object> get messages => events.stream;
  @override
  void send(String value) => sent.add(value);
  @override
  Future<void> close() async {
    closed = true;
    await events.close();
  }
}

Map<String, dynamic> grant(String state) => {
  'id': 'grant-one',
  'sourceClientId': 'source-pc',
  'state': state,
  'permission': 'view',
  'canControl': false,
  'expiresAt': DateTime.now().millisecondsSinceEpoch / 1000 + 300,
};

const jpeg = <int>[
  255,
  216,
  255,
  192,
  0,
  11,
  8,
  0,
  10,
  0,
  20,
  1,
  1,
  17,
  0,
  255,
  217,
];
void sendFrame(Connection connection, {int sequence = 1, bool ready = true}) {
  if (ready) {
    connection.events.add(
      jsonEncode({'type': 'ready', 'role': 'viewer', 'permission': 'view'}),
    );
  }
  connection.events.add(
    jsonEncode({
      'type': 'frame',
      'sequence': sequence,
      'width': 20,
      'height': 10,
      'at': DateTime.now().millisecondsSinceEpoch / 1000,
    }),
  );
  connection.events.add(jpeg);
}

void main() {
  test('pending consent never connects to media', () async {
    var connections = 0;
    final controller = RemoteScreenController(
      baseUrl: Uri.parse('http://127.0.0.1:18891'),
      request: (method, path, {body}) async => grant('pending'),
      connect: (_) async {
        connections++;
        return Connection();
      },
    );
    await controller.start('source-pc');
    expect(connections, 0);
    expect(controller.frame, isNull);
    expect(controller.status, contains('等待电脑'));
    await controller.stop();
    controller.dispose();
  });

  test(
    'approved viewer uses a short first-frame ticket and stop clears pixels immediately',
    () async {
      final connection = Connection();
      final paths = <String>[];
      Uri? mediaUri;
      final controller = RemoteScreenController(
        baseUrl: Uri.parse('http://127.0.0.1:18891'),
        request: (method, path, {body}) async {
          paths.add(path);
          if (path.endsWith('/ticket')) {
            return {'role': 'viewer', 'ticket': 'fixture-ticket'};
          }
          return grant('active');
        },
        connect: (uri) async {
          mediaUri = uri;
          return connection;
        },
      );
      await controller.start('source-pc');
      expect(mediaUri!.query, isEmpty);
      expect(jsonDecode(connection.sent.first), {
        'type': 'auth',
        'ticket': 'fixture-ticket',
      });
      sendFrame(connection);
      await Future<void>.delayed(Duration.zero);
      expect(controller.frame, isNotNull);
      final stopping = controller.stop();
      expect(controller.frame, isNull);
      await stopping;
      expect(connection.closed, isTrue);
      expect(paths.last, endsWith('/stop'));
      controller.dispose();
    },
  );

  test('identity change and unsolicited binary pixels fail closed', () async {
    for (final reason in ['identity', 'binary', 'duplicate']) {
      final connection = Connection();
      var current = true;
      final controller = RemoteScreenController(
        baseUrl: Uri.parse('http://127.0.0.1:18891'),
        isCurrent: () => current,
        request: (method, path, {body}) async => path.endsWith('/ticket')
            ? {'role': 'viewer', 'ticket': 'fixture-ticket'}
            : grant('active'),
        connect: (_) async => connection,
      );
      await controller.start('source-pc');
      if (reason == 'binary') {
        connection.events.add(jpeg);
      } else {
        sendFrame(connection);
        await Future<void>.delayed(Duration.zero);
        expect(controller.frame, isNotNull);
        if (reason == 'identity') current = false;
        sendFrame(connection, ready: false);
      }
      await Future<void>.delayed(Duration.zero);
      expect(controller.frame, isNull, reason: reason);
      expect(controller.ended, isTrue, reason: reason);
      controller.dispose();
    }
  });

  test(
    'closed source channel removes the last image and ends the grant',
    () async {
      final connection = Connection();
      final controller = RemoteScreenController(
        baseUrl: Uri.parse('http://127.0.0.1:18891'),
        request: (method, path, {body}) async => path.endsWith('/ticket')
            ? {'role': 'viewer', 'ticket': 'fixture-ticket'}
            : grant('active'),
        connect: (_) async => connection,
      );
      await controller.start('source-pc');
      sendFrame(connection);
      await Future<void>.delayed(Duration.zero);
      await connection.events.close();
      await Future<void>.delayed(Duration.zero);
      expect(controller.ended, isTrue);
      expect(controller.frame, isNull);
      controller.dispose();
    },
  );
}
