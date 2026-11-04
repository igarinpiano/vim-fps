# vim-fps installer for Windows (x64, ARM64, x86). Downloads the release
# archive from GitHub Releases, checks it against SHA256SUMS, installs
# vimfps.exe and adds its folder to your user PATH.
#
#   irm https://igarinpiano.github.io/vim-fps/install.ps1 | iex
#
# Environment:
#   VIMFPS_VERSION      version to install (e.g. 1.1.1; default: latest)
#   VIMFPS_INSTALL_DIR  where to put vimfps.exe
#                       (default: %LOCALAPPDATA%\Programs\vimfps)
#   VIMFPS_TARGET       override the detected target triple
#   GITHUB_TOKEN        optional, raises the GitHub API rate limit

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5 defaults to old TLS versions.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'igarinpiano/vim-fps'

function Get-Target {
    if ($env:VIMFPS_TARGET) { return $env:VIMFPS_TARGET }
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
        'AMD64' { return 'x86_64-pc-windows-msvc' }
        'ARM64' { return 'aarch64-pc-windows-msvc' }
        'x86' { return 'i686-pc-windows-msvc' }
        default { throw "この CPU ($arch) 向けのビルドはありません" }
    }
}

$headers = @{ 'User-Agent' = 'vimfps-installer' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

$target = Get-Target
$version = $env:VIMFPS_VERSION
if (-not $version) {
    $rel = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repo/releases/latest"
    $version = $rel.tag_name
}
$version = $version.TrimStart('v')
$name = "vimfps-$version-$target"
$base = "https://github.com/$Repo/releases/download/v$version"
$dir = $env:VIMFPS_INSTALL_DIR
if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'Programs\vimfps' }

Write-Host "vim-fps v$version ($target) を $dir にインストールします"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("vimfps-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp "$name.zip"
    $sums = Join-Path $tmp 'SHA256SUMS'
    Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri "$base/$name.zip" -OutFile $zip
    Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri "$base/SHA256SUMS" -OutFile $sums
    $want = $null
    foreach ($line in Get-Content $sums) {
        $parts = $line -split '\s+'
        if ($parts.Length -ge 2 -and $parts[1].TrimStart('*') -eq "$name.zip") { $want = $parts[0] }
    }
    if (-not $want) { throw "SHA256SUMS に $name.zip がありません" }
    $got = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    if ($got -ne $want.ToLower()) { throw "SHA-256 が一致しません (期待 $want, 実際 $got)" }
    Write-Host 'SHA-256 を確認しました'

    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $exe = Join-Path $dir 'vimfps.exe'
    if (Test-Path $exe) {
        # A running vimfps.exe cannot be overwritten, but it can be renamed.
        Move-Item -Force $exe "$exe.old"
    }
    Copy-Item -Force (Join-Path $tmp "$name\vimfps.exe") $exe
    Remove-Item -Force "$exe.old" -ErrorAction SilentlyContinue
    Write-Host "インストールしました: $exe"
    & $exe --version

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $dir)) {
        $newPath = if ($userPath) { "$userPath;$dir" } else { $dir }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        $env:Path = "$env:Path;$dir"
        Write-Host "$dir をユーザーの PATH に追加しました (新しいターミナルから使えます)"
    }
    Write-Host ''
    Write-Host 'ホストを立てる: vimfps host    更新: vimfps update'
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
