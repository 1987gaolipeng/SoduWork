# Bundled Chinese typography

SoduWork bundles the official **Noto Sans SC** TrueType variable font so the
standalone app, Flutter Web build, and embedded SDK can render Simplified
Chinese without relying on fonts installed on the host device.

- Source: `google/fonts/ofl/notosanssc/NotoSansSC[wght].ttf`
- License: SIL Open Font License 1.1 (`OFL-NotoSansSC.txt`)
- Flutter family: `Noto Sans SC`

The TrueType file is intentional. The smaller CFF/OTF regional build renders
in normal browser text, but produced missing-glyph boxes in Flutter Web's
canvas renderer. Keep the real Web rendering check when changing this asset.
