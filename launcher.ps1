param([string]$Action = '')

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Port = 7788
$PidFile = Join-Path $Root 'data\server.pid'
$LogFile = Join-Path $Root 'data\server.log'
$ErrFile = Join-Path $Root 'data\server.err.log'
$Url = "http://127.0.0.1:$Port"

function Get-NodePath {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $b = 'C:\Users\kazur\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path $b) { return $b }
    return $null
}

function Get-State {
    try { return Invoke-RestMethod -Uri "$Url/api/state" -TimeoutSec 2 } catch { return $null }
}

function Start-Server {
    if (Get-State) { return 'already' }
    $node = Get-NodePath
    if (-not $node) { return 'nonode' }
    $dataDir = Join-Path $Root 'data'
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    $p = Start-Process -FilePath $node -ArgumentList 'server.mjs' `
        -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile
    Set-Content -Path $PidFile -Value $p.Id -Encoding ASCII
    Start-Sleep -Milliseconds 1000
    if (Get-State) { return 'ok' }
    return 'failed'
}

function Stop-Server {
    $target = $null
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { $target = $conn.OwningProcess }
    elseif (Test-Path $PidFile) { $target = (Get-Content $PidFile -Raw).Trim() }
    if ($target) { Stop-Process -Id ([int]$target) -Force -ErrorAction SilentlyContinue }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 600
    return (-not [bool](Get-State))
}

# ---------------- 命令行模式（便于排查） ----------------
if ($Action -eq 'start') {
    $r = Start-Server
    Write-Output $r
    exit 0
}
if ($Action -eq 'stop') {
    $ok = Stop-Server
    if ($ok) { Write-Output 'stopped' } else { Write-Output 'failed' }
    exit 0
}
if ($Action -eq 'status') {
    if (Get-State) { Write-Output 'running' } else { Write-Output 'stopped' }
    exit 0
}

# ---------------- 图形界面 ----------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bg = [System.Drawing.Color]::FromArgb(14, 17, 22)
$accent = [System.Drawing.Color]::FromArgb(79, 124, 255)
$muted = [System.Drawing.Color]::FromArgb(139, 149, 166)
$green = [System.Drawing.Color]::FromArgb(34, 197, 94)
$red = [System.Drawing.Color]::FromArgb(239, 68, 68)
$dark = [System.Drawing.Color]::FromArgb(43, 52, 66)

function New-Label($text, $x, $y, $w, $h, $size, $color, $bold) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text
    $l.Location = New-Object System.Drawing.Point($x, $y)
    $l.Size = New-Object System.Drawing.Size($w, $h)
    $style = [System.Drawing.FontStyle]::Regular
    if ($bold) { $style = [System.Drawing.FontStyle]::Bold }
    $l.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', $size, $style)
    $l.ForeColor = $color
    $l.BackColor = [System.Drawing.Color]::Transparent
    return $l
}

function New-Button($text, $x, $y, $w, $h, $back, $fore) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.Location = New-Object System.Drawing.Point($x, $y)
    $b.Size = New-Object System.Drawing.Size($w, $h)
    $b.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $b.FlatAppearance.BorderSize = 0
    $b.BackColor = $back
    $b.ForeColor = $fore
    $b.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5, [System.Drawing.FontStyle]::Bold)
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    return $b
}

$form = New-Object System.Windows.Forms.Form
$form.Text = '多AI聊天台'
$form.ClientSize = New-Object System.Drawing.Size(400, 300)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
$form.MaximizeBox = $false
$form.BackColor = $bg
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.Icon = [System.Drawing.SystemIcons]::Application

$form.Controls.Add((New-Label '◆ 多AI聊天台' 24 18 320 32 15 $accent $true))

$script:statusLabel = New-Label '●  检查中…' 24 62 320 24 11 $muted $true
$form.Controls.Add($script:statusLabel)

$script:infoLabel = New-Label "端口 $Port" 24 90 352 22 9 $muted $false
$form.Controls.Add($script:infoLabel)

$script:btnStart = New-Button '启动' 24 132 110 40 $accent White
$script:btnStop = New-Button '停止' 144 132 110 40 $dark White
$script:btnOpen = New-Button '打开网页' 264 132 112 40 $dark White
$form.Controls.Add($script:btnStart)
$form.Controls.Add($script:btnStop)
$form.Controls.Add($script:btnOpen)

$script:logLink = New-Label '查看日志' 24 192 100 22 9 $muted $false
$script:logLink.Cursor = [System.Windows.Forms.Cursors]::Hand
$form.Controls.Add($script:logLink)

$form.Controls.Add((New-Label '关掉这个窗口会一并停止服务' 24 258 352 20 8.5 $muted $false))

function Update-Ui {
    $s = Get-State
    if ($s) {
        $script:statusLabel.Text = '●  运行中'
        $script:statusLabel.ForeColor = $green
        $script:btnStart.Enabled = $false
        $script:btnStop.Enabled = $true
        $script:btnOpen.Enabled = $true
        $spent = [double]$s.usage.total
        $budget = [double]$s.settings.monthlyBudgetCNY
        $script:infoLabel.Text = ("端口 $Port    本月 ¥{0:N4} / ¥{1:N0}" -f $spent, $budget)
    } else {
        $script:statusLabel.Text = '●  已停止'
        $script:statusLabel.ForeColor = $red
        $script:btnStart.Enabled = $true
        $script:btnStop.Enabled = $false
        $script:btnOpen.Enabled = $false
        $script:infoLabel.Text = "端口 $Port    服务未运行"
    }
}

$script:btnStart.Add_Click({
    $script:statusLabel.Text = '●  正在启动…'
    $script:statusLabel.ForeColor = $muted
    $script:statusLabel.Refresh()
    $r = Start-Server
    if ($r -eq 'nonode') {
        [System.Windows.Forms.MessageBox]::Show('没找到 Node.js，请先安装 Node.js。', '多AI聊天台') | Out-Null
    } elseif ($r -eq 'failed') {
        [System.Windows.Forms.MessageBox]::Show('启动失败，点「查看日志」看具体原因。', '多AI聊天台') | Out-Null
    }
    Update-Ui
})

$script:btnStop.Add_Click({
    Stop-Server | Out-Null
    Update-Ui
})

$script:btnOpen.Add_Click({
    Start-Process $Url
})

$script:logLink.Add_Click({
    if (Test-Path $LogFile) { Start-Process notepad.exe $LogFile }
    else { [System.Windows.Forms.MessageBox]::Show('还没有日志，先启动一次。', '多AI聊天台') | Out-Null }
})

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 2000
$script:timer.Add_Tick({ Update-Ui })
$script:timer.Start()

$form.Add_FormClosing({
    param($sender, $e)
    if (Get-State) {
        $r = [System.Windows.Forms.MessageBox]::Show(
            '服务还在运行，退出时会一并停止。确定吗？',
            '多AI聊天台',
            [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
            [System.Windows.Forms.MessageBoxIcon]::Question)
        if ($r -eq [System.Windows.Forms.DialogResult]::Cancel) { $e.Cancel = $true }
        elseif ($r -eq [System.Windows.Forms.DialogResult]::Yes) { Stop-Server | Out-Null }
    }
})

Update-Ui
[void]$form.ShowDialog()
$script:timer.Stop()
