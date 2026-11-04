# vim-fps

**マウス禁止。Vim のキーだけで戦うブラウザ FPS。**

移動・視点・アイテム選択がそれぞれ別の「モード」になっていて、同時には使えません。
FPS の経験よりも、どのモードで何をするかの判断と、キー入力の正確さが勝負になります。

- ブラウザで遊べます: **https://igarinpiano.github.io/vim-fps/** (練習モード / トンネルのサーバーへの接続)
- マルチプレイは CLI (`vimfps`) でホストします。LAN か Cloudflare Quick Tunnel で配信します
- 個人戦 (フリー・フォー・オール)。全員の基本性能は同じで、違いは拾った装備だけです

## 遊び方

### 1 人で練習する
https://igarinpiano.github.io/vim-fps/ を開いて「練習する」を選びます (bot と対戦。ブラウザ内で動くのでサーバーは不要です)。

### 友だちと遊ぶ (ホスト)
[Releases](https://github.com/igarinpiano/vim-fps/releases) から自分の OS のファイルを入れて:

```bash
vimfps host
```

表示された `http://<LAN の IP>:7777/` を同じネットワークの人が開けば参加できます。

インターネット越しに遊ぶときは [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) を入れて:

```bash
vimfps host --tunnel --password 合言葉
```

`https://….trycloudflare.com/#pw=合言葉` という URL (と QR コード) が出るので、それを共有します。
URL は起動のたびに変わります。

| オプション | 説明 |
|---|---|
| `--port 7777` | 待ち受けポート |
| `--bind 127.0.0.1` | LAN に公開しない |
| `--tunnel` | Cloudflare Quick Tunnel で公開 |
| `--password PW` | 合言葉 (URL の `#pw=` で渡す) |
| `--bots N` | bot を入れる |
| `--max-players 12` | 最大人数 (bot を除く) |
| `--time-limit 10` | 1 試合の分数 |
| `--frag-limit 25` | このキル数で試合終了 |
| `--seed N` | マップのシード |

### 更新

```bash
vimfps update
```

GitHub Releases の最新版をダウンロードし、SHA-256 を確かめてから自分自身を置き換えます (`--check` で確認だけ)。
ホスト起動時にも新しい版があれば知らせます (`--no-update-check` で無効)。

## 操作

`Esc` の代わりに `Ctrl-[` も使えます (ブラウザは `Esc` でフルスクリーンを抜けるため)。

### NORMAL (移動)
| キー | 動作 |
|---|---|
| `h` `j` `k` `l` | 左・後・前・右に歩く (前進キーは `:set forward=k` / `j`) |
| `Shift` を押している間 | スニーク (遅い・足音が小さい・頭が低い) |
| `{n}k` など | n メートル歩く |
| `<<` / `>>` | 左 / 右に 45° 旋回 (`{n}<<`、角度は `:set turnangle`) |
| `~` | 180° 振り返る |
| `f` | 撃つ / 選んでいるアイテムを使う (腰撃ちは弾が散る) |
| `{n}dd` | グレネードを投げる (n=1〜5 で強さ、省略時 3) |
| `r` | リロード |
| `y` | 足元の銃を拾う (銃は 2 丁まで。持っている銃と交換) |
| `gt` | 2 丁の銃を持ち替え |
| `s` | インベントリ |
| `m` | マップ |
| `i` | チャット (全員に届きます) |
| `:` | コマンド |

### VIEW (`v`: 構える。歩けません)
| キー | 動作 |
|---|---|
| `h` `j` `k` `l` | 視点移動 (カーソルと同じ向き)。短く押すと 1 目盛り、押し続けると加速 |
| `H` `J` `K` `L` | 速く回す |
| `{n}l` など | n 目盛り回す |
| `v` | スコープ (もう一度で戻る) |
| `f` | 撃つ |
| `{n}dd` | 狙って投げる |
| `Esc` | NORMAL へ |

### INVENTORY (`s`)
縦のリストで、`j` / `k` で銃・回復キット・グレネードを選び、`Enter` / `Esc` で閉じてから `f` で使います。
`gg` / `G` / 数字でも選べます。

## 設定 (`:set`)

Vim と同じ書き方です。設定はブラウザに保存されます。

```vim
:set sens=120          " 視点移動の初速 (度/秒)
:set accel=600         " 加速度 (度/秒²)。inf で押した瞬間から最高速、0 で一定
:set maxspeed=360      " 最高速
:set step=0.5          " 短押し・回数指定 1 回の角度
:set aimdelay=80       " 押しっぱなしが連続移動になるまで (ms)
:set zoomsens=0.4      " スコープ中の倍率
:set invert            " 上下反転 (:set noinvert で戻す)
:set forward=j         " j を前進に
:set nosmooth          " アニメーション・補間・加速をすべてオフ
:set sens?             " 値を見る
:set sens&             " 初期値に戻す
:set all               " すべて表示
:options               " 一覧と説明
```

### アニメーションなしで遊ぶ
`:set nosmooth` で、滑らかにするための処理をすべて切ります。

| 個別の設定 | オフにすると |
|---|---|
| `noadsanim` | 構え・スコープが瞬時に切り替わる |
| `nomoveaccel` | 移動の加速度が無限大 (押した瞬間に最高速、離した瞬間に停止) |
| `noturnanim` | `<<` `>>` `~` の旋回が瞬時 |
| `nointerp` | 他プレイヤーを受信した位置にそのまま表示 |
| `nobob` | 歩行の揺れ・反動の表示なし |
| `nouianim` | 通知のフェードや爆発のアニメーションなし |

`:set smooth` で全部元に戻ります。

## ゲームのルール
- 個人戦。制限時間 (既定 10 分) か、誰かが規定キル数 (既定 25) に届いたら終了。結果を 10 秒表示して次の試合へ
- 倒されると 3 秒後に復活。最初は AR、回復キット 1、グレネード 1
- 武器: AR / SMG / SG / SR。頭に当てるとダメージが増えます (SR は頭なら 1 発)
- 構える (VIEW) と弾が集まり、スコープ (`v` をもう一度) でさらに集まります
- 回復キット (+60)、グレネード、弾薬はマップに落ちていて、歩いて触れると拾えます

## 開発

```bash
scripts/build-wasm.sh           # 練習モード用の wasm を web/pkg/ に
cargo run -p vimfps -- host     # web/ を埋め込んだホストを起動
cargo test --workspace
node --test tests/web/*.test.mjs
```

| 場所 | 中身 |
|---|---|
| `crates/vimfps-core` | ゲームのルール (マップ生成、武器、当たり判定、bot、通信メッセージ)。サーバーとブラウザで同じものを使います |
| `crates/vimfps-wasm` | 練習モード用に `vimfps-core` をブラウザで動かす wasm |
| `crates/vimfps` | CLI (`host` / `update`)。HTTP + WebSocket サーバー、Cloudflare Quick Tunnel、自己アップデート |
| `web/` | ブラウザのクライアント (three.js、XP 風の UI、Vim のキー処理) |

### リリース
1. `Cargo.toml` の `version` と `web/js/version.js` を上げる
2. Actions → **publish-all** → Run workflow (GitHub Releases に全プラットフォームのバイナリと `SHA256SUMS`)
3. GitHub Pages は `main` への push で **pages** ワークフローが更新します (初回のみ Settings → Pages → Source を「GitHub Actions」に)

## ライセンス
Apache-2.0。同梱の three.js は MIT License (`web/vendor/three-LICENSE.txt`)。
