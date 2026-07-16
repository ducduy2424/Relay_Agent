# Gỡ Unicorn Relay Agent: xóa scheduled task + dừng tiến trình node của relay.
#   powershell -ExecutionPolicy Bypass -File uninstall_relay.ps1
# Không xóa thư mục source / node_modules / logs — chỉ ngừng chạy tự động.

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$TaskName = "Unicorn Relay Agent"

function Write-Step {
  param([string]$Message)
  Write-Host "[uninstall] $Message" -ForegroundColor Cyan
}

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Please run this script as Administrator."
  }
}

try {
  Assert-Admin

  $projectRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path

  # 1) Dừng + xóa task (bỏ qua nếu task không tồn tại). Dùng cmdlet thay vì schtasks.exe:
  #    dưới PS 5.1 + EAP Stop, stderr "ERROR: ..." của schtasks (task không tồn tại / không
  #    đang chạy) bị biến thành lỗi terminating → abort uninstall trước cả bước /delete.
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Write-Step "Stopping task '$TaskName' (if running)"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

    Write-Step "Deleting task '$TaskName'"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  else {
    Write-Step "Task '$TaskName' not found — skipping."
  }

  # 2) Kill mọi node.exe đang chạy từ thư mục này (supervisor + relay).
  #    Giết supervisor trước cũng được: supervisor chết thì không còn ai respawn.
  Write-Step "Stopping node processes under $projectRoot"
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($projectRoot) }
  foreach ($p in $procs) {
    Write-Step "  Killing PID $($p.ProcessId): $($p.CommandLine)"
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {
      Write-Host "  Warning: could not kill PID $($p.ProcessId): $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
  if (-not $procs) {
    Write-Step "  No relay node processes found."
  }

  # 3) Dọn lock file để lần cài lại sau không bị PID stale.
  $lockFile = Join-Path $projectRoot "logs\supervisor.lock"
  if (Test-Path -LiteralPath $lockFile) {
    Remove-Item -LiteralPath $lockFile -Force
    Write-Step "Removed $lockFile"
  }

  Write-Host ""
  Write-Host "Uninstall completed." -ForegroundColor Green
}
catch {
  Write-Host ""
  Write-Host "Uninstall failed." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
