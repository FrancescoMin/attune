/*
 * codec.js — Windows Bluetooth audio codec & profile detection (main process).
 *
 * Inspects:
 *  • Active default audio render endpoint via Core Audio (MMDeviceEnumerator)
 *    for profile (A2DP Stereo vs HFP Hands-Free) and PCM format (rate/bits/ch).
 *  • Connected Bluetooth A2DP / HFP / LE PnP devices and bound driver
 *    (Microsoft BthA2dp vs Alternative A2DP Driver).
 *  • Windows BthA2dp Registry parameters (BluetoothAacEnable) and Alternative
 *    A2DP Driver configuration when present.
 */

'use strict';

const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let win = null;
let pollTimer = null;
let activeProc = null;
let lastDeviceName = '';
let lastJson = '';

function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { return fs.existsSync(full) ? full : 'powershell.exe'; } catch (_) { return 'powershell.exe'; }
}

function buildProbeScript(deviceName) {
  const safeName = String(deviceName || '').replace(/'/g, "''").trim();
  return `
$ProgressPreference = 'SilentlyContinue'
$targetName = '${safeName}'

$cs = @'
using System;
using System.Runtime.InteropServices;

namespace AttuneAudio {
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ComImport]
  public class MMDeviceEnumeratorComObject {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IntPtr ppInterface);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
  }

  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    int GetCount(out int cProps);
    int GetAt(int iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROPERTYKEY {
    public Guid fmtid;
    public int pid;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct Blob {
    public int cbSize;
    public IntPtr pBlobData;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct PROPVARIANT {
    [FieldOffset(0)] public short vt;
    [FieldOffset(8)] public IntPtr pwszVal;
    [FieldOffset(8)] public Blob blob;
  }

  public static class Probe {
    public static string[] GetDefaultRender() {
      try {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice dev;
        int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        if (hr != 0 || dev == null) return new string[] { "", "", "0", "0", "0" };
        string id;
        dev.GetId(out id);
        IPropertyStore store;
        dev.OpenPropertyStore(0, out store);

        var pkeyName = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
        PROPVARIANT pvName;
        store.GetValue(ref pkeyName, out pvName);
        string name = (pvName.vt == 31 && pvName.pwszVal != IntPtr.Zero) ? Marshal.PtrToStringUni(pvName.pwszVal) : "";

        var pkeyFmt = new PROPERTYKEY { fmtid = new Guid("f19f064d-082c-4e27-bc73-6882a1bb8e4c"), pid = 0 };
        PROPVARIANT pvFmt;
        store.GetValue(ref pkeyFmt, out pvFmt);
        int ch = 0, sr = 0, bits = 0;
        if (pvFmt.vt == 65 && pvFmt.blob.cbSize >= 16 && pvFmt.blob.pBlobData != IntPtr.Zero) {
          ch = Marshal.ReadInt16(pvFmt.blob.pBlobData, 2);
          sr = Marshal.ReadInt32(pvFmt.blob.pBlobData, 4);
          bits = Marshal.ReadInt16(pvFmt.blob.pBlobData, 14);
        }
        return new string[] { name ?? "", id ?? "", ch.ToString(), sr.ToString(), bits.ToString() };
      } catch {
        return new string[] { "", "", "0", "0", "0" };
      }
    }
  }
}
'@

if (-not ('AttuneAudio.Probe' -as [type])) {
  Add-Type -TypeDefinition $cs -ErrorAction SilentlyContinue | Out-Null
}

$def = [AttuneAudio.Probe]::GetDefaultRender()
$defName = $def[0]
$defCh = [int]$def[2]
$defSr = [int]$def[3]
$defBits = [int]$def[4]

$a2dpDevs = @(Get-PnpDevice -InstanceId 'BTHENUM\\{0000110B-0000-1000-8000-00805F9B34FB}*' -Status OK -ErrorAction SilentlyContinue)
$a2dp = $null
if ($targetName -and $a2dpDevs.Count -gt 0) {
  $a2dp = $a2dpDevs | Where-Object { $_.FriendlyName -like "*$targetName*" } | Select-Object -First 1
}
if (-not $a2dp -and $a2dpDevs.Count -gt 0) {
  $a2dp = $a2dpDevs | Where-Object { $defName -and $defName -like "*$($_.FriendlyName)*" } | Select-Object -First 1
}
if (-not $a2dp -and $a2dpDevs.Count -gt 0) {
  $a2dp = $a2dpDevs[0]
}

$svc = ''
$drvProvider = ''
$drvDesc = ''
$a2dpName = ''
if ($a2dp) {
  $a2dpName = $a2dp.FriendlyName
  $props = $a2dp | Get-PnpDeviceProperty -KeyName DEVPKEY_Device_Service, DEVPKEY_Device_DriverProvider, DEVPKEY_Device_DriverDesc -ErrorAction SilentlyContinue
  foreach ($p in $props) {
    if ($p.KeyName -eq 'DEVPKEY_Device_Service') { $svc = "$($p.Data)" }
    elseif ($p.KeyName -eq 'DEVPKEY_Device_DriverProvider') { $drvProvider = "$($p.Data)" }
    elseif ($p.KeyName -eq 'DEVPKEY_Device_DriverDesc') { $drvDesc = "$($p.Data)" }
  }
}

$hfpDevs = @(Get-PnpDevice -InstanceId 'BTHHFENUM\\*' -Status OK -ErrorAction SilentlyContinue)
$hfpMatch = $false
if ($defName -and $hfpDevs.Count -gt 0) {
  foreach ($h in $hfpDevs) {
    if ($defName -like "*$($h.FriendlyName)*" -or $defName -match 'Hands-Free') { $hfpMatch = $true; break }
  }
}

$leDevs = @(Get-PnpDevice -InstanceId 'BTHLE\\*' -Status OK -ErrorAction SilentlyContinue | Where-Object { $_.Class -eq 'MEDIA' })
$leActive = ($leDevs.Count -gt 0) -and ($targetName -eq '' -or ($leDevs | Where-Object { $_.FriendlyName -like "*$targetName*" }).Count -gt 0)

$aacReg = $null
try {
  $p = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\BthA2dp\\Parameters' -Name 'BluetoothAacEnable' -ErrorAction SilentlyContinue
  if ($p -ne $null -and $null -ne $p.BluetoothAacEnable) { $aacReg = [int]$p.BluetoothAacEnable }
} catch {}

$altCodec = ''
if ($svc -match 'AltA2dp' -or $drvProvider -match 'Bluetooth Goodies' -or $drvDesc -match 'Alternative A2DP') {
  foreach ($root in @('HKLM:\\SOFTWARE\\BluetoothGoodies\\AltA2dp', 'HKCU:\\SOFTWARE\\BluetoothGoodies\\AltA2dp')) {
    try {
      if (Test-Path $root) {
        $sub = Get-ChildItem -Path $root -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($sub) {
          $cp = Get-ItemProperty -Path $sub.PSPath -ErrorAction SilentlyContinue
          if ($cp.Codec) { $altCodec = "$($cp.Codec)"; break }
        }
      }
    } catch {}
  }
}

$out = [ordered]@{
  defName = $defName
  defCh = $defCh
  defSr = $defSr
  defBits = $defBits
  a2dpConnected = ($null -ne $a2dp)
  a2dpName = $a2dpName
  service = $svc
  driverProvider = $drvProvider
  driverDesc = $drvDesc
  hfpActive = $hfpMatch
  leActive = $leActive
  aacEnable = $aacReg
  altCodec = $altCodec
}
Write-Output ($out | ConvertTo-Json -Compress)
`;
}

function classifyProbe(raw) {
  if (!raw || typeof raw !== 'object') {
    return { codec: '—', profile: 'Unknown', quality: 'none', detail: 'Detection unavailable', exact: false };
  }

  const sr = Number(raw.defSr) || 0;
  const bits = Number(raw.defBits) || 0;
  const ch = Number(raw.defCh) || 0;
  const fmtParts = [];
  if (sr > 0) fmtParts.push(sr >= 1000 ? `${(sr / 1000).toFixed(sr % 1000 === 0 ? 0 : 1)} kHz` : `${sr} Hz`);
  if (bits > 0) fmtParts.push(`${bits}-bit`);
  if (ch > 0) fmtParts.push(ch === 1 ? 'Mono' : 'Stereo');
  const fmt = fmtParts.join(' · ');

  const isTargetDefault = raw.defName && (
    (raw.a2dpName && raw.defName.toLowerCase().includes(raw.a2dpName.toLowerCase())) ||
    (lastDeviceName && raw.defName.toLowerCase().includes(lastDeviceName.toLowerCase()))
  );

  // Hands-Free (call mode) active as default output
  if (raw.hfpActive && (isTargetDefault || /hands-free/i.test(raw.defName || ''))) {
    return {
      codec: 'HFP',
      profile: 'Hands-Free (mSBC/CVSD)',
      quality: 'call',
      sampleRate: sr,
      bitsPerSample: bits,
      channels: ch,
      driver: raw.service || 'BthHfAud',
      endpoint: raw.defName || '',
      detail: fmt ? `Hands-Free Call · ${fmt}` : 'Hands-Free Call Profile',
      exact: true
    };
  }

  // LE Audio
  if (raw.leActive) {
    return {
      codec: 'LC3',
      profile: 'LE Audio',
      quality: 'high',
      sampleRate: sr,
      bitsPerSample: bits,
      channels: ch,
      driver: raw.service || 'BthLE',
      endpoint: raw.defName || '',
      detail: fmt ? `LE Audio · ${fmt}` : 'LE Audio (LC3)',
      exact: true
    };
  }

  // A2DP Stereo
  if (raw.a2dpConnected) {
    const isAlt = /alta2dp/i.test(raw.service || '') || /bluetooth goodies|alternative a2dp/i.test((raw.driverProvider || '') + ' ' + (raw.driverDesc || ''));
    if (isAlt && raw.altCodec) {
      const c = String(raw.altCodec).toUpperCase();
      const q = /LDAC|LHDC|APTX.*HD|APTX.*ADAPTIVE/.test(c) ? 'hi-res' : (/AAC|APTX/.test(c) ? 'good' : 'standard');
      return {
        codec: c,
        profile: 'A2DP Stereo',
        quality: q,
        sampleRate: sr,
        bitsPerSample: bits,
        channels: ch,
        driver: 'Alternative A2DP',
        endpoint: raw.defName || raw.a2dpName || '',
        detail: [isTargetDefault ? 'Active output' : 'Standby (not default output)', fmt, 'Alternative A2DP'].filter(Boolean).join(' · '),
        exact: true
      };
    }

    if (raw.aacEnable === 0) {
      return {
        codec: 'SBC',
        profile: 'A2DP Stereo',
        quality: 'standard',
        sampleRate: sr,
        bitsPerSample: bits,
        channels: ch,
        driver: raw.service || 'BthA2dp',
        endpoint: raw.defName || raw.a2dpName || '',
        detail: [isTargetDefault ? 'A2DP Stereo' : 'Standby (not default output)', fmt, 'AAC disabled in Windows'].filter(Boolean).join(' · '),
        exact: true
      };
    }

    return {
      codec: 'AAC / SBC',
      profile: 'A2DP Stereo',
      quality: 'good',
      sampleRate: sr,
      bitsPerSample: bits,
      channels: ch,
      driver: raw.service || 'BthA2dp',
      endpoint: raw.defName || raw.a2dpName || '',
      detail: [isTargetDefault ? 'A2DP Stereo' : 'Standby (not default output)', fmt, 'Windows BthA2dp (AAC enabled)'].filter(Boolean).join(' · '),
      exact: false
    };
  }

  return {
    codec: '—',
    profile: 'No A2DP link',
    quality: 'none',
    sampleRate: sr,
    bitsPerSample: bits,
    channels: ch,
    driver: '',
    endpoint: raw.defName || '',
    detail: 'No active Bluetooth audio profile detected',
    exact: false
  };
}

function runProbe(deviceName) {
  if (typeof deviceName === 'string' && deviceName.trim()) lastDeviceName = deviceName.trim();
  if (process.platform !== 'win32') {
    return Promise.resolve({
      codec: '—', profile: 'Unsupported OS', quality: 'none',
      detail: 'Windows Bluetooth audio detection only', exact: false
    });
  }

  return new Promise((resolve) => {
    const script = buildProbeScript(lastDeviceName);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let stdout = '';
    let settled = false;

    const finish = (res) => {
      if (settled) return;
      settled = true;
      activeProc = null;
      resolve(res);
    };

    try {
      const proc = spawn(
        powershellExe(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true }
      );
      activeProc = proc;
      const timer = setTimeout(() => {
        try { proc.kill(); } catch (_) {}
        finish(classifyProbe(null));
      }, 6000);

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.on('error', () => { clearTimeout(timer); finish(classifyProbe(null)); });
      proc.on('close', () => {
        clearTimeout(timer);
        let parsed = null;
        try {
          const line = stdout.trim().split(/\r?\n/).pop();
          if (line) parsed = JSON.parse(line);
        } catch (_) {}
        finish(classifyProbe(parsed));
      });
    } catch (_) {
      finish(classifyProbe(null));
    }
  });
}

async function pollOnce() {
  if (!win || win.isDestroyed()) return;
  const info = await runProbe(lastDeviceName);
  const json = JSON.stringify(info);
  if (json !== lastJson) {
    lastJson = json;
    try { win.webContents.send('codec:update', info); } catch (_) {}
  }
}

function register(mainWin) {
  win = mainWin;
  ipcMain.handle('codec:detect', async (_e, deviceName) => {
    const info = await runProbe(deviceName);
    lastJson = JSON.stringify(info);
    return info;
  });
  ipcMain.handle('codec:start', async (_e, deviceName) => {
    if (typeof deviceName === 'string' && deviceName.trim()) lastDeviceName = deviceName.trim();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    lastJson = '';
    const info = await runProbe(lastDeviceName);
    lastJson = JSON.stringify(info);
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('codec:update', info); } catch (_) {}
    }
    pollTimer = setInterval(pollOnce, 10000);
    return info;
  });
  ipcMain.handle('codec:stop', () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    lastJson = '';
  });
}

function dispose() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (activeProc) { try { activeProc.kill(); } catch (_) {} activeProc = null; }
  win = null;
}

module.exports = { register, dispose };
