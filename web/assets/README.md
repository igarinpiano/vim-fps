# assets — ゲームと一緒に配る素材 (同梱のスキン)

ここは **同梱のスキン** です。`skin.json` に書いたテクスチャ・効果音・UI の色が、このサイト (公開版) や、このファイルを配信するホストで遊ぶ全員の既定になります。
各自のスキンやホストのスキン (`vimfps host --skin`) は、この上に項目ごとに重なります。

`skin.json` の書き方・貼れる場所・鳴る場面・変えられる色の一覧は **[設定ファイルとスキン](../../docs/config.md#スキン)** にあります。

```json
{
  "name": "xp",
  "textures": { "ground": "textures/grass.png", "wall": { "file": "textures/brick.jpg", "size": 3 } },
  "sounds": { "startup": "sounds/startup.wav", "error": "sounds/error.wav" },
  "ui": { "crosshair": "#00ff66" }
}
```

- ファイル名は**半角英数字と `.` `_` `-` だけ**にしてください (空白や日本語を含むファイルは公開版に載りません)
- 今入っているのは XP 風の効果音 (`sounds/`) です
- `skin.json` が無いときは、前の版の置き方 (`textures/pack.json` と `sounds/<場面>.wav`) を読みます
