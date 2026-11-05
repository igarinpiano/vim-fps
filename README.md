# vim-fps

**マウス禁止。Vim のキーだけで戦うブラウザ FPS。**

移動・視点・アイテム選択がそれぞれ別の「モード」になっていて、同時には使えません。
FPS の経験よりも、どのモードで何をするかの判断と、キー入力の正確さが勝負になります。

- ブラウザで遊べます: **https://igarinpiano.github.io/vim-fps/** (練習モード / トンネルのサーバーへの接続)
- マルチプレイは CLI (`vimfps`) でホストします。LAN か Cloudflare Quick Tunnel で配信します
- 個人戦 (フリー・フォー・オール)。全員の基本性能は同じで、違いは拾った装備だけです
- 丘や谷のある野外マップ。高所から撃ち下ろす・稜線に隠れる、といった立ち回りができます
- スマートフォン・タブレットでは画面上のキーパッドで遊べます (`:set touch=on/off`)

## 遊び方

### 1 人で練習する
https://igarinpiano.github.io/vim-fps/ を開いて選びます (ブラウザ内で動くのでサーバーは不要です)。

- **射撃訓練場**: 10〜400 m に的 (左右に動く的・遮蔽物の陰の的もあり) が並ぶ長い射撃場。後ろの台に全武器と回復・グレネード・弾薬があり、`y` で持ち替えます。弾は減らず、的は倒しても 1 秒で戻ります。当てたダメージが数字で出ます
- **カスタムマッチ**: bot の数 (0〜15 体)、bot の強さ (5 段階)、ルール (復活あり / 復活なし)、時間、終了キル数、マップ (ランダムかシード番号) を選んで始めます。`j`/`k` で項目、`h`/`l` で値 (`H`/`L` で 5 ずつ)、`Enter` で開始。前回の設定を覚えています
- **練習する**: bot と個人戦
- **練習する (復活なし)**: 最後の 1 人が勝つラウンド制。倒されると、倒した相手の視点で観戦します

### インストール
**Linux / macOS / FreeBSD / NetBSD / illumos / Android (Termux)**

```bash
curl -fsSL https://igarinpiano.github.io/vim-fps/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/igarinpiano/vim-fps/main/scripts/install.ps1 | iex
```

OS と CPU を判定して [Releases](https://github.com/igarinpiano/vim-fps/releases) から合うファイルをダウンロードし、`SHA256SUMS` で確かめてからインストールします。

- インストール先: `~/.local/bin` (Termux では `$PREFIX/bin`、Windows では `%LOCALAPPDATA%\Programs\vimfps`。Windows ではユーザーの PATH にも追加します)
- Linux では、どのディストリビューションでも動く静的リンク版 (musl) を選びます
- 環境変数 `VIMFPS_VERSION=1.1.1` で版を指定、`VIMFPS_INSTALL_DIR` で置き場所を指定できます
- スクリプトは [`scripts/install.sh`](scripts/install.sh) と [`scripts/install.ps1`](scripts/install.ps1) にあります。手動で入れる場合は Releases から `vimfps-<版>-<ターゲット>` を展開してください

### 友だちと遊ぶ (ホスト)

```bash
vimfps host
```

表示された `http://<LAN の IP>:7777/` を同じネットワークの人が開けば参加できます。

ホストは起動のたびに GitHub Pages から**最新の Web クライアント**を取得して配信します (10 分ごとにも確認)。
取得できないとき (オフラインなど) や、公開版のプロトコルがこの CLI と合わないときは、CLI に埋め込まれた版を使います。

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
| `--bots N` | bot を入れる (0〜15) |
| `--bot-skill 1〜5` | bot の強さ (下の表) |
| `--max-players 12` | 最大人数 (bot を除く) |
| `--time-limit 10` | 1 試合の分数 |
| `--frag-limit 25` | このキル数で試合終了 |
| `--seed N` | マップのシード |
| `--no-respawn` | 復活なし: 最後の 1 人が勝つラウンド制 (倒された人は観戦、次のラウンドで全員復帰) |
| `--web URL` / `--web embedded` | 配信する Web クライアント (既定: GitHub Pages の最新版) |
| `--no-network-check` | macOS: 起動時の接続の確認 (下) をしない |

#### macOS で LAN からつながらないとき

macOS では、次の 2 つのどちらかで、ほかの端末からホストに接続できないことがあります。

- **ファイアウォール** が `vimfps` への接続を許可していない (「外部からの接続をすべてブロック」を含む)
- **ローカルネットワークの制限** (macOS 15 以降): `vimfps` を動かしているターミナルのアプリ (iTerm・VS Code など。標準の「ターミナル」は対象外) がローカルネットワークを使えない

`vimfps host` は起動時にこれを調べ、見つかれば許可するコマンドを表示して `[y/N]` で聞きます。`y` なら (管理者のパスワードを聞いてから) 実行します:

```text
● Allowing vimfps through the firewall... done
│
● Allowing the local network 192.168.1.0/24... done
│
● Ready to host!
```

実行するコマンドは次のとおりです (手で実行しても同じです):

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add ~/.local/bin/vimfps
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp ~/.local/bin/vimfps
sudo defaults write com.apple.network.local-network AllowedWiFiLocalNetworkAddresses -array-add 192.168.1.0/24
sudo defaults write com.apple.network.local-network AllowedEthernetLocalNetworkAddresses -array-add 192.168.1.0/24
```

最後の 2 行は、その LAN (例: `192.168.1.0/24`) へのアクセスを**すべてのアプリ**に許可します (macOS 15.5 以降)。
アプリごとに許可したいときは、代わりに「システム設定 > プライバシーとセキュリティ > ローカルネットワーク」でターミナルのアプリをオンにして、開き直してください。

### bot の強さ
| 段階 | 見える距離 | 反応 | 照準のぶれ | 振り向き | 偏差撃ち |
|---|---|---|---|---|---|
| 1 とても弱い | 70 m | 0.9 s | ×2.4 | 遅い | なし |
| 2 弱い | 110 m | 0.6 s | ×1.6 | やや遅い | なし |
| 3 普通 | 150 m | 0.35 s | ×1.0 | 普通 | なし |
| 4 強い | 170 m | 0.25 s | ×0.6 | 速い | あり (動く相手の先と落下を狙う) |
| 5 とても強い | 200 m | 0.15 s | ×0.3 | とても速い | あり |

(反応は遠い相手ほど遅くなります: + 距離 / 250 秒)。練習中は `:bots N` で数、`:botskill N` で強さを変えられます。

### 観戦
- ホストのページのメニューで「このサーバーを観戦」を選ぶと、試合に出ずに見られます (観戦者は人数制限に数えません)。`:play` で途中参加、`:watch` で観戦に戻ります
- 復活なしの試合で倒されると、ブルースクリーンのあと**倒した相手の視点**の中継になります (`:set nokillcam` にすると自由視点)
- 観戦中のキー (SPECTATE モード):

| キー | 動作 |
|---|---|
| `n` / `N` | 次 / 前の選手を追う (`:follow 名前` でも) |
| `o` | 自由視点 (`k`/`j` 前後、`h`/`l` 旋回、`K`/`J` 上下、Shift で速く、`,` `.` で 45°) |
| `O` | 空からの視点 (真上から見下ろす。`hjkl` で移動、`K`/`J` で高さ、Shift で速く、`,` `.` で回転)。全員に ▼ と名前が付きます |
| `m` | マップ: 観戦中は全員の位置・向き・名前・HP が出ます (追っている人は黄色) |
| `i` / `:` | チャット / コマンド |

観戦中は、追っている選手の視点 (構え・スコープも含む) と、左上のカード (名前・HP ゲージ・武器・構え・キル / デス) が見えます。

### 更新

```bash
vimfps update
```

GitHub Releases の最新版をダウンロードし、SHA-256 を確かめてから自分自身を置き換えます (`--check` で確認だけ)。
ホスト起動時にも新しい版があれば知らせます (`--no-update-check` で無効)。

### アンインストール

```bash
vimfps uninstall
```

実行ファイルそのものを削除します (`-y` で確認なし)。CLI はほかにファイルを作らないので、これで全部です。
手順ごとに ○ が ● に変わって進みます:

```text
● Removing C:\Users\you\AppData\Local\Programs\vimfps from PATH... done
│
● Deleting C:\Users\you\AppData\Local\Programs\vimfps\vimfps.exe... done
│
● Deleting C:\Users\you\AppData\Local\Programs\vimfps... done
│
● Thank you for using vim-fps!
```

- **Windows**: インストールスクリプトのフォルダ (`%LOCALAPPDATA%\Programs\vimfps`) ごと削除し、ユーザーの PATH からも外します。ほかのファイルも入っているフォルダに置いた場合は、`vimfps.exe` だけを消し、フォルダと PATH はそのままにします
- **Linux / macOS / *BSD / illumos / Termux**: `vimfps` を削除します。シェルの設定ファイルに PATH を足す行を書いた場合は、ほかに使っていなければ消してください
- ゲームの設定 (`:set` など) はブラウザのサイトデータに残ります。消すには、ブラウザの設定で `igarinpiano.github.io` (またはホストのアドレス) のデータを削除してください

1.5.0 までの版には `uninstall` がないので、手で消してください: `rm ~/.local/bin/vimfps` (Termux は `rm "$PREFIX/bin/vimfps"`)。Windows では `%LOCALAPPDATA%\Programs\vimfps` を削除し、「環境変数」の設定でユーザーの `Path` からそのフォルダを外します。

## 操作

`Esc` の代わりに `Ctrl-[` も使えます (ブラウザは `Esc` でフルスクリーンを抜けるため)。

### NORMAL (移動)
| キー | 動作 |
|---|---|
| `h` `j` `k` `l` | 左・後・前・右に歩く (前進キーは `:set forward=k` / `j`) |
| `Shift` を押している間 | スニーク (遅い・足音が小さい・頭が低い) |
| `{n}k` など | n メートル歩く |
| `,` / `.` | 左 / 右に 45° 旋回 (`{n},`、角度は `:set turnangle`) |
| `~` | 180° 振り返る |
| `f` | 撃つ / 選んでいるアイテムを使う (腰撃ちは弾が散る) |
| `{n}dd` | グレネードを投げる (n=1〜5 で強さ、省略時 3) |
| `r` | リロード |
| `y` | 足元の銃を拾う (銃は 2 丁まで。持っている銃と交換) |
| `gt` | 2 丁の銃を持ち替え |
| `*` | 照準の近くに見えている敵をマーク (6 秒間、壁越しでも ▼ が見える) |
| `s` | インベントリ |
| `m` | マップ |
| `i` | チャット (全員に届きます。スマホでは「取り消し」ボタン、ウィンドウの ×、パッドの Esc で閉じる) |
| `:` | コマンド |

割り当てのないキーは何もしません。

### VIEW (`v`: 構える。歩けません)
| キー | 動作 |
|---|---|
| `h` `j` `k` `l` | 視点移動 (カーソルと同じ向き)。短く押すと 1 目盛り (0.2°)、押し続けるとまずゆっくり (微調整)、しばらくすると加速 |
| `H` `J` `K` `L` | 速く回す |
| `{n}l` など | n 目盛り回す |
| `v` | スコープの倍率を切り替え (SR は構えた時点で低倍率スコープ、`v` で高倍率) |
| `f` | 撃つ |
| `{n}dd` | 狙って投げる |
| `*` | 敵をマーク |
| `Esc` | NORMAL へ |

### INVENTORY (`s`)
縦のリストで、`j` / `k` で銃・回復キット・グレネードを選び、`Enter` / `Esc` で閉じてから `f` で使います。
`gg` / `G` / 数字でも選べます。

### 索敵
- 画面上の**コンパス**に、銃声 (赤 ●、3.5 秒)、近くを走る敵の足音 (橙 ●、35 m 以内)、マークした敵 (黄 ▼) の方向が出ます。スニーク中の足音は出ません
- 見えている敵の頭上に赤い ▼ が付きます (`:set nomarkers` で消す)
- マップ (`m`) にも最近の銃声が赤い輪で出ます
- キルの通知と倒されたときのダイアログに、相手との距離が出ます

### 名前と体力ゲージ
- 他の選手の頭上に**名前**が出ます (`:set nonameplates` で消す)
- 名前の下に**体力ゲージ**が出ます (緑 → 黄 → 赤)。対戦中のプレイヤーには相手の HP は送られないので、ゲージが出るのは**観戦中**と**オフライン練習・射撃訓練場**だけです (`:set nohpbars` で消す)

### 通信統計
- `:set netstat` で右上に ping (平均・最小・最大・ゆれ)、受信間隔、通信量が常に出ます
- `:net` でくわしい一覧 (接続先、ping、スナップショットの受信間隔と最大の空き、通信量の毎秒・合計、サーバーの計算・送信レート) を開きます
- タイトルバーの ping は 1 秒ごとに測ります。練習モードでは、ブラウザ内のシミュレーションまでの往復時間です

## 仕様 (`:spec`)
ゲーム内で `:spec` を実行すると、遊んでいるサーバーの数値がそのまま表示されます。

- **弾は実際に飛びます。** 銃ごとの初速で撃ち出され、重力 9.81 m/s² で落ちます (空気抵抗なし: 位置 = 初速 × t + ½ × g × t²)。遠くの相手には、届くまでの時間の分だけ先を、落ちる分だけ上を狙います
- SR のスコープには落下の目盛り (1〜4 = 100〜400 m) が出ます。中心に近すぎて見分けられない距離の目盛りは省きます

| 初速 | 100 m | 200 m | 300 m | 400 m |
|---|---|---|---|---|
| AR 880 m/s | 0.11 s / 6 cm | 0.23 s / 25 cm | 0.34 s / 57 cm | (射程外) |
| SMG 400 m/s | 0.25 s / 31 cm | 0.50 s / 123 cm | (射程外) | (射程外) |
| SG 380 m/s | (射程外) | (射程外) | (射程外) | (射程外) |
| SR 850 m/s | 0.12 s / 7 cm | 0.24 s / 27 cm | 0.35 s / 61 cm | 0.47 s / 109 cm |

(到達時間 / 落下量。SG の射程は 60 m)

- HP 100、頭の当たり判定は半径 0.25 m

| 武器 | ダメージ 胴 / 頭 | 連射 | 装弾 / 予備 | リロード | 拡散 腰 / 構え / スコープ | 距離減衰 | 射程 |
|---|---|---|---|---|---|---|---|
| AR | 26 / 52 | 600 rpm 連射 | 30 / 150 | 2.2 s | 4° / 0.6° / 0.4° | 35→100 m で ×0.6 | 300 m |
| SMG | 19 / 34.2 | 857 rpm 連射 | 32 / 160 | 1.8 s | 2.8° / 1.2° / 1.0° | 15→50 m で ×0.45 | 200 m |
| SG | 13×9 / 19.5×9 | 71 rpm 単発 | 6 / 36 | 2.6 s | 6° / 4.5° / 4.5° | 8→30 m で ×0.15 | 60 m |
| SR | 85 / 212.5 | 46 rpm 単発 | 5 / 25 | 3.0 s | 10° / 0.15° / 0° | なし | 400 m |

- 腰撃ちで歩いていると拡散 ×1.3。構え (VIEW) 中は歩けません
- 移動: 走り 6 m/s、スニーク 2.6 m/s、加速度 40 m/s² (`:set nomoveaccel` で無限大)
- 回復キット +60 HP (1.6 秒、最大 3 個)。グレネード: 信管 3 秒、半径 7 m、最大 120 ダメージ (距離で減少、壁で遮られる、最大 3 個)、初速 `1dd`=9.5 〜 `5dd`=23.5 m/s
- 復活 3 秒後、復活直後 1.5 秒は無敵 (撃つと解除)

## 設定 (`:set`)

Vim と同じ書き方です。設定はブラウザに保存されます。

```vim
:set step=0.1          " 短押し・回数指定 1 回の角度 (既定 0.2°)
:set sens=8            " 長押しの初速 = 微調整の速さ (度/秒、既定 12)
:set accelafter=800    " 長押しがこの時間 (ms) を超えたら加速を始める (既定 450)
:set accel=600         " 加速度 (度/秒²)。inf で加速開始と同時に最高速、0 でずっと一定
:set maxspeed=360      " 最高速 (既定 220)
:set aimdelay=80       " 押しっぱなしが連続移動になるまで (ms)
:set zoomsens=0.5      " 構え・スコープ中の倍率。視点速度と 1 目盛りは元々ズーム率に比例して細かくなり (SR スコープなら約 0.18 倍、1 目盛り約 0.04°)、さらにこの値が掛かる
:set touch=on          " タッチ用キーパッド (auto / on / off)
:set nocompass         " 索敵コンパスを消す
:set nokillcam         " 復活なしで倒されたら自由視点で観戦
:set nodmgnum          " ダメージの数字を出さない
:set nonameplates      " 頭上の名前を出さない
:set nohpbars          " 頭上の体力ゲージを出さない
:set netstat           " 通信統計 (ping・受信間隔・通信量) を表示
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
| `noturnanim` | `,` `.` `~` の旋回が瞬時 |
| `nointerp` | 他プレイヤーを受信した位置にそのまま表示 |
| `nobob` | 歩行の揺れ・反動の表示なし |
| `nouianim` | 通知のフェードや爆発のアニメーションなし |

`:set smooth` で全部元に戻ります。

## ゲームのルール
- 個人戦。制限時間 (既定 10 分) か、誰かが規定キル数 (既定 25) に届いたら終了。結果を 10 秒表示して次の試合へ
- 倒されるとブルースクリーン (倒した相手・武器・距離が出ます) になり、自動で再起動して 3 秒後に復活。最初は AR、回復キット 1、グレネード 1
- bot は 150 m 先まで見え、120 m 以内の銃声と近くの足音を聞いてそちらへ向かいます
- 武器: AR / SMG / SG / SR。頭に当てるとダメージが増えます (SR は頭なら 1 発)
- 構える (VIEW) と弾が集まり、スコープ (`v` をもう一度) でさらに集まります。SR は構えた時点で低倍率スコープです
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
1. `Cargo.toml` の `version` と `web/js/version.js` を上げる (通信の形を変えたら `PROTOCOL` も、`crates/vimfps-core/src/protocol.rs` と `web/js/net.js` の両方)
2. Actions → **publish-all** → Run workflow (GitHub Releases に全プラットフォームのバイナリと `SHA256SUMS`)
3. GitHub Pages は `main` への push で **pages** ワークフローが更新します (`scripts/build-site.sh` が `manifest.json` を作り、各ホストはそれを見て最新版を取得します)

## ライセンス
Apache-2.0。同梱の three.js は MIT License (`web/vendor/three-LICENSE.txt`)。
