# 設定ファイルとスキン

vim-fps で自分好みに変えられるものは、次の 2 つにまとまっています。

| | 中身 | 形 |
|---|---|---|
| **設定ファイル** (`.vimfpsrc`) | `:set` の設定、使うスキン、カスタムマッチの値、ホスト (`vimfps host`) のオプション | テキストファイル 1 つ。Vim の `vimrc` と同じ書き方 |
| **スキン** | テクスチャ (地面・壁などの画像)、効果音、UI の色 | `skin.json` のあるフォルダー 1 つ (または、それを固めた zip) |

**全部まとめて持ち運ぶ**には、ゲーム内で `:mkvimrc!` を実行します。`.vimfpsrc` と今のスキンが入った zip が 1 つできます。
別のブラウザーやスマートフォンでは、その zip をページにドロップすれば (または `:source` で選べば) 全部入ります。

- [設定ファイル (.vimfpsrc)](#設定ファイル-vimfpsrc)
- [スキン](#スキン)
- [ブラウザーの中の保存場所](#ブラウザーの中の保存場所)

---

## 設定ファイル (.vimfpsrc)

### 書き方

```vim
" vim-fps の設定ファイル。" から行末まではコメント
set adssens=30 forward=j      " :set と同じ。1 行に何個でも
set nocompass
skin neon                     " このブラウザーに入れたスキンを使う
custom bots=8 skill=4 rule=last time=15

" vimfps host が読む行 (ブラウザーでは使いません)
host bots=5 bot-skill=4 time-limit=15
host tunnel password=合言葉
host name=週末\ サーバー        " 空白は前に \ を付ける
```

- 1 行に 1 つのコマンド。行の先頭の `:` は書いても書かなくてもかまいません (`:set sens=8` も可)
- `"` で始まる語から行末まではコメントです (`password=a"b` のように語の途中の `"` は文字として扱います)
- 値に空白を入れるときは `\ ` と書きます (`\` の次の文字はそのまま。`\\` で `\` 自体)
- 間違った行はエラーとして行番号つきで表示し、残りの行はそのまま実行します (Vim と同じ)

### コマンド

| コマンド | 意味 | 読むもの |
|---|---|---|
| `set …` | `:set` と同じ ([設定の一覧](https://github.com/igarinpiano/vim-fps#設定-set)、ゲーム内の `:options`)。`set all&` ですべて初期値に戻す | ブラウザー |
| `skin 名前` | このブラウザーに入れたスキンを使う。`skin off` で使わない | ブラウザー |
| `custom キー=値 …` | カスタムマッチのフォームの値 (下の表) | ブラウザー |
| `host キー=値 …` | `vimfps host` のオプション ([下の表](#host-の項目)) | `vimfps host` |

`custom` の項目:

| キー | 値 | 既定 |
|---|---|---|
| `bots` | bot の数 0〜15 | 5 |
| `skill` | bot の強さ 1〜5 | 3 |
| `rule` | `ffa` (復活あり) / `last` (復活なし: 最後の 1 人が勝ち) | `ffa` |
| `time` | 試合の長さ (分) 1〜60 | 10 |
| `frags` | 終了キル数 0〜100 (0 で時間まで) | 25 |
| `ring` | `on` / `off` | `on` |
| `tanks` | `on` / `off` | `on` |
| `seed` | マップのシード 0〜99999 (0 でランダム) | 0 |

### ブラウザーで使う

| コマンド | 動作 |
|---|---|
| `:mkvimrc` | 今の状態 (変えた設定・スキン・カスタムマッチ・覚えている `host` の行) を `.vimfpsrc` としてダウンロード |
| `:mkvimrc!` | `.vimfpsrc` と今のスキン (`:texture` で貼った画像も入れて) をまとめた `vimfps-profile.zip` をダウンロード |
| `:source` | `.vimfpsrc` (か、それの入った zip) を選んで読み込む |
| `:source URL` | URL の `.vimfpsrc` や zip を読み込む |
| `:custom bots=8 rule=last` | カスタムマッチの値を変える (`:custom` だけならフォームを開く) |
| `:host` | 覚えている `host` の行を表示 |
| `:help config` | この説明の短い版 |

- ファイルをページへ**ドラッグ & ドロップ**しても読み込めます。`.vimfpsrc` (`_vimfpsrc`、`vimfpsrc`、`*.vim` でも可) はそのまま読み込み、zip とフォルダーは中のスキンを入れてから中の `.vimfpsrc` を読みます
- `:mkvimrc` が書くファイルは `set all&` で始まるので、読み込むと書き出したときと同じ状態に戻ります
- ブラウザーは `host` の行を使いませんが、読み込んだ分を覚えておき、`:mkvimrc` で書き戻します。ブラウザーとホストで 1 つのファイルを使い回せます
- ダウンロードするときに、ブラウザーによってはファイル名の先頭の `.` が外れたり `.txt` が付いたりします (`vimfpsrc.txt` など)。どの名前でも読み込めます。`vimfps host` で使うときは名前を `.vimfpsrc` に直してください

### vimfps host で使う

`vimfps host` は起動するとき、次の順で設定ファイルを探して `host` の行を読みます (ほかの行は飛ばします)。

1. `--config パス` で指定したファイル (無ければエラー)
2. `~/.vimfpsrc` (Windows では `%USERPROFILE%\.vimfpsrc`)
3. `~/_vimfpsrc`

```bash
vimfps config           # どのファイルを読むか、host に足されるオプションを表示
vimfps config --init    # ~/.vimfpsrc のひな形を作る (すでにあれば何もしない)
vimfps host --no-config # 設定ファイルを読まずに起動
```

- `host bots=5` は `--bots 5` と同じです。**コマンドラインで指定したほうが優先**します (`host bots=5` があっても `vimfps host --bots 9` なら 9)
- `tunnel` のようなスイッチは名前だけ書きます。`tunnel=off` と書けばその行では付けません
- `skin=` の相対パスは、設定ファイルのある場所から数えます
- 知らない項目や値の無い項目は、行番号つきの警告を出して飛ばします
- `host password=…` は平文でファイルに残ります。人に渡すファイルには書かないでください
- 引数なしで起動 (ダブルクリック) したときも `~/.vimfpsrc` を読みます

### host の項目

コマンドラインのオプション ([README](https://github.com/igarinpiano/vim-fps#友だちと遊ぶ-ホスト)) から `--` を取ったものです。`_` は `-` と同じに扱います (`bot_skill` = `bot-skill`)。

| 項目 | 例 | 意味 |
|---|---|---|
| `port` | `port=7777` | 待ち受けポート |
| `bind` | `bind=127.0.0.1` | 待ち受けアドレス |
| `tunnel` | `tunnel` | Cloudflare Quick Tunnel で公開 |
| `password` | `password=合言葉` | 合言葉 |
| `bots` | `bots=5` | bot の数 (0〜15) |
| `bot-skill` | `bot-skill=4` | bot の強さ (1〜5) |
| `max-players` | `max-players=12` | 最大人数 (bot を除く) |
| `time-limit` | `time-limit=15` | 1 試合の分数 |
| `frag-limit` | `frag-limit=25` | このキル数で試合終了 |
| `seed` | `seed=42` | マップのシード |
| `name` | `name=vim-fps` | サーバー名 |
| `no-respawn` | `no-respawn` | 復活なし (最後の 1 人が勝つラウンド制) |
| `no-ring` | `no-ring` | リングなし |
| `no-tanks` | `no-tanks` | 戦車なし |
| `skin` | `skin=./my-skin` | 参加者全員に配るスキン ([下](#全員に配る-ホストのスキン)) |
| `web` | `web=embedded` | 配信する Web クライアント |
| `no-update-check` | `no-update-check` | 起動時に新しい版を確認しない |
| `no-network-check` | `no-network-check` | macOS: ファイアウォールの確認をしない |

---

## スキン

スキンは、テクスチャ・効果音・UI の色をまとめたフォルダーです。中に `skin.json` を置き、使うファイルをそこからの相対パスで書きます。

```
neon/
├── skin.json
├── textures/
│   ├── grass.png
│   └── brick.jpg
└── sounds/
    └── boot.wav
```

```json
{
  "name": "neon",
  "textures": {
    "ground": "textures/grass.png",
    "wall": { "file": "textures/brick.jpg", "size": 3 },
    "sky": "textures/sky.jpg"
  },
  "sounds": {
    "startup": "sounds/boot.wav",
    "error2": "sounds/hit.ogg"
  },
  "ui": {
    "window": "#1e1e2e",
    "text": "#e0e0ff",
    "title-a": "#7a3cff",
    "crosshair": "#00ff66"
  }
}
```

- どの項目も省略できます。書いていないものは、下の段 (ホストのスキンや同梱の素材) のものが使われます
- `name` は `skin 名前` で選ぶときの名前です (空白は `-` になります)。省略するとフォルダーや zip の名前です
- ファイル名は半角英数字と `.` `_` `-` だけで、`/` で区切ったフォルダーの中も指せます。`..` や `.` で始まる名前、URL は使えません

**`skin.json` が無いフォルダー**も、ファイル名で読みます: `ground.png`・`wall-brick.jpg` のように貼る場所の名前で始まる画像はテクスチャに、`startup.wav`・`error2.ogg` のような名前の音声は効果音になります。

### textures (テクスチャ)

地形 (形) はそのままで、面の色を画像に置き換えます。`"場所": "ファイル"` か `"場所": { "file": "ファイル", "size": メートル }`。`size` は画像 1 枚が覆う大きさ (0.1〜500) で、小さいほど細かく繰り返します。

| 場所 | 面 | 既定の size |
|---|---|---|
| `ground` | 地面 | 8 |
| `wall` | 建物の壁 | 4 |
| `roof` | 屋根 | 4 |
| `rock` | 岩 | 3 |
| `cover` | 低い壁 (遮蔽物) | 3 |
| `crate` | 木箱 | 2 |
| `trunk` | 木の幹 | 1 |
| `fence` | 外周のフェンス | 4 |
| `leaves` | 木の葉 | 2 |
| `tank` | 戦車 | 2 |
| `sky` | 空 (横長のパノラマ画像。繰り返さない) | — |

画像は png / jpg / webp / gif / avif / bmp。1 枚 24 MB まで。当たり判定は変わりません。

### sounds (効果音)

| 場面 | 鳴るとき |
|---|---|
| `startup` | スポーンした時 (起動音) |
| `error` | キルされた時 (エラー音) |
| `error2` | 被弾した時 (ダメージを受けるたび。リングの外のダメージも) |
| `shutdown` | 試合が終わった時 (システム終了音) |

音声は wav / mp3 / ogg。どのスキンにも無い場面では何も鳴りません (`error2` だけは合成音が鳴ります)。銃声や足音は合成音で、差し替えられません。

### ui (画面の色)

XP 風の画面の色を変えます。値は CSS の色 (`#rrggbb`、`rgb(…)`、`hsl(…)`、色の名前、`linear-gradient(…)` など)。`font` / `mono` はフォント名の並び (`"Comic Sans MS", sans-serif`)。`url(…)` や `;` を含む値は使えません。

| キー | 場所 | 既定 |
|---|---|---|
| `bg` | デスクトップ (背景) | `#3a6ea5` |
| `window` | ウィンドウの地 | `#ece9d8` |
| `window-edge` | ウィンドウの枠 | `#0b45b8` |
| `title-a` | タイトルバー (中央) | `#0a5ee8` |
| `title-b` | タイトルバー (上端) | `#3d95ff` |
| `title-c` | タイトルバー (下端) | `#0645c8` |
| `text` | 文字 | `#000` |
| `muted` | 薄い文字 (ヒント) | `#555` |
| `select` | 選択中の行 | `#316ac5` |
| `taskbar-a` | タスクバー (上) | `#2a62db` |
| `taskbar-b` | タスクバー (下) | `#1c4bbf` |
| `start-a` | スタートボタン (上) | `#3f9b3f` |
| `start-b` | スタートボタン (下) | `#2b7a2b` |
| `tray` | タスクバー右端 | `#0f8ae8` |
| `crosshair` | 照準 (腰撃ち・構えたときの十字) | `#fff` |
| `font` | 文字のフォント | system-ui ほか |
| `mono` | 等幅フォント | ui-monospace ほか |

### 重なる順

スキンは項目ごとに重なります。下ほど優先です。

1. **同梱**: ゲームと一緒に配信されるもの (`web/assets/skin.json`。公開版では XP 風の効果音)
2. **ホスト**: `vimfps host --skin フォルダー` で配られるもの (そのホストに接続したとき)
3. **自分のスキン**: このブラウザーに入れて `:skin 名前` で選んだもの
4. **`:texture`**: 1 枚ずつ貼った画像 (テクスチャだけ)

たとえばホストが地面の画像を配っていても、自分のスキンに `ground` があればそちらが見えます。自分のスキンに `ground` が無ければホストの地面が見えます。

### スキンを入れる・使う

| コマンド | 動作 |
|---|---|
| `:skin` | 重なっているスキンと、このブラウザーに入っているスキンの一覧 |
| `:skin load` | zip、または `skin.json` と素材のファイルを選んで入れる |
| `:skin 名前` | そのスキンを使う |
| `:skin off` | 自分のスキンを使わない (ホストと同梱の分だけ) |
| `:skin export [名前]` | スキンを zip で書き出す (省略すると使用中のもの) |
| `:skin rm 名前` | このブラウザーから消す |

- **フォルダーか zip をページへドラッグ & ドロップ**すると、そのスキンが入って使用中になります。同じ名前のスキンは入れ替わります
- 入れたスキンはそのブラウザーに保存され (IndexedDB)、次に開いたときも使われます。ほかの人の画面には影響しません
- スキン全体で 64 MB まで。zip は無圧縮と deflate (普通の zip) に対応しています (暗号化・zip64 は不可)

### 全員に配る (ホストのスキン)

`vimfps host` にスキンのフォルダーを渡すと、接続した全員に配ります。

```bash
vimfps host --skin ./neon
```

`~/.vimfpsrc` に `host skin=./neon` と書いても同じです。フォルダーは `skin/` という URL で配信され、ファイルは毎回ディスクから読むので、書き換えたら参加者がページを読み直すだけで反映されます。
`skin.json` が無い・JSON として正しくないときは、起動せずにエラーを表示します。

### 公開版・自分のサイトの同梱スキン

ゲームと一緒に配る素材は [`web/assets/`](https://github.com/igarinpiano/vim-fps/tree/main/web/assets) にあり、`web/assets/skin.json` がその内容です (ここを書き換えると、そのサイトやホストで遊ぶ全員の既定になります)。
`skin.json` を置いていない古い構成 (`web/assets/textures/pack.json` と `web/assets/sounds/<場面>.wav`) も、これまでどおり読みます。

---

## ブラウザーの中の保存場所

| 中身 | 場所 |
|---|---|
| `:set` の設定、カスタムマッチ、使うスキンの名前、`host` の行 | localStorage の `vimfps.profile.v2` (1 つのキー) |
| スキン (画像・音声) と `:texture` の画像 | IndexedDB の `vimfps` |

どれもそのブラウザーの中だけにあり、サーバーには送りません。前の版の `vimfps.settings.v1` / `vimfps.custom.v1` は、最初に開いたときに `vimfps.profile.v2` へ移します。
ブラウザーを変えるとき・消える前に取っておくときは `:mkvimrc!` で zip に書き出してください。
