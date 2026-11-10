import 'dart:typed_data';
import 'package:flutter/material.dart';
import '../core/mobile_library.dart';

class LibraryEntryTile extends StatelessWidget {
  final bool grid;
  final Widget leading, trailing;
  final String name, info, date;
  final VoidCallback? onTap;
  const LibraryEntryTile({
    super.key,
    required this.grid,
    required this.leading,
    required this.trailing,
    required this.name,
    required this.info,
    this.date = '',
    this.onTap,
  });
  @override
  Widget build(BuildContext context) {
    final secondary = Theme.of(context).textTheme.bodySmall;
    final title = Text(name, maxLines: 2, overflow: TextOverflow.ellipsis);
    final details = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (info.isNotEmpty)
          Text(
            info,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: secondary,
          ),
        if (date.isNotEmpty) Text(date, style: secondary),
      ],
    );
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: grid
          ? InkWell(
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [leading, const Spacer(), trailing]),
                    title,
                    const SizedBox(height: 4),
                    details,
                  ],
                ),
              ),
            )
          : ListTile(
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 16,
                vertical: 8,
              ),
              leading: leading,
              trailing: trailing,
              title: title,
              subtitle: Padding(
                padding: const EdgeInsets.only(top: 4),
                child: details,
              ),
              onTap: onTap,
            ),
    );
  }
}

class LibraryImageThumbnail extends StatefulWidget {
  final MobileLibrary library;
  final Map<String, dynamic> item;
  const LibraryImageThumbnail({
    super.key,
    required this.library,
    required this.item,
  });

  @override
  State<LibraryImageThumbnail> createState() => _LibraryImageThumbnailState();
}

class _LibraryImageThumbnailState extends State<LibraryImageThumbnail> {
  late final Future<Uint8List> _bytes = widget.library
      .read(widget.item, limit: 2 * 1024 * 1024)
      .then((file) => file.bytes);

  @override
  Widget build(BuildContext context) => FutureBuilder<Uint8List>(
    future: _bytes,
    builder: (_, snap) {
      const fallback = Icon(Icons.image_outlined);
      final data = snap.data;
      if (data == null) return fallback;
      return ClipRRect(
        borderRadius: BorderRadius.circular(6),
        child: Image.memory(
          data,
          width: 36,
          height: 36,
          cacheWidth: 96,
          fit: BoxFit.cover,
          errorBuilder: (_, _, _) => fallback,
        ),
      );
    },
  );
}
