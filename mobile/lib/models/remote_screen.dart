class RemoteScreenGrant {
  final String id;
  final String sourceClientId;
  final String state;
  final double expiresAt;

  const RemoteScreenGrant({
    required this.id,
    required this.sourceClientId,
    required this.state,
    required this.expiresAt,
  });

  factory RemoteScreenGrant.fromJson(Map<String, dynamic> json) {
    if (json['permission'] != 'view' ||
        json['canControl'] != false ||
        json['id'] is! String ||
        (json['id'] as String).isEmpty) {
      throw const FormatException('看屏服务返回了不支持的授权');
    }
    return RemoteScreenGrant(
      id: json['id'] as String,
      sourceClientId: json['sourceClientId'] as String,
      state: json['state'] as String,
      expiresAt: (json['expiresAt'] as num).toDouble(),
    );
  }
}
