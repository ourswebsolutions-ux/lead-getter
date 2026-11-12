'use strict';

// Windows automatic sign-in, the way Windows supports it (and Microsoft's
// Sysinternals Autologon tool does it): Winlogon's AutoAdminLogon with the
// password kept as the LSA secret "DefaultPassword", which Windows encrypts
// and only administrators' processes can read. The password is never written
// to the registry as text, nor to Lead Finder's database, settings or logs.
//
// Changing it needs administrator rights, so Windows shows its own UAC
// prompt (Lead Finder never bypasses it). The password is handed over as a
// DPAPI-encrypted blob (readable only by this Windows account), written to a
// private temporary file, never on a command line; the elevated step
// decrypts it, stores the secret and deletes the file.
//
// This signs the account in after a restart or a power cut; it does not
// unlock a locked screen and does not touch the lock screen. Turning the
// computer back on after a power cut is a BIOS/UEFI setting ("Restore on AC
// power loss"), which no program can change.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const WINLOGON = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon';
const PASSWORDLESS = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\PasswordLess\\Device';

// The LSA calls, for PowerShell (Add-Type).
const LSA_CS = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class LfLsa {
  [StructLayout(LayoutKind.Sequential)] struct U { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct A { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public int Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref A attributes, int access, out IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr handle, ref U key, IntPtr data);
  [DllImport("advapi32.dll")] static extern uint LsaRetrievePrivateData(IntPtr handle, ref U key, out IntPtr data);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr p);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  const int POLICY_ALL_ACCESS = 0x000F0FFF;
  static U Str(string s) { U u = new U(); u.Buffer = Marshal.StringToHGlobalUni(s); u.Length = (ushort)(s.Length * 2); u.MaximumLength = (ushort)(u.Length + 2); return u; }
  static void Check(uint status) { if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status)); }
  static IntPtr Open() { A a = new A(); a.Length = Marshal.SizeOf(a); IntPtr h; Check(LsaOpenPolicy(IntPtr.Zero, ref a, POLICY_ALL_ACCESS, out h)); return h; }
  public static void Store(string key, string value) {
    IntPtr h = Open(); U k = Str(key); IntPtr data = IntPtr.Zero; U v = new U();
    try {
      if (value != null) { v = Str(value); data = Marshal.AllocHGlobal(Marshal.SizeOf(v)); Marshal.StructureToPtr(v, data, false); }
      uint st = LsaStorePrivateData(h, ref k, data);
      if (value == null && st == 0xC0000034) return; // already absent
      Check(st);
    } finally {
      if (data != IntPtr.Zero) { Marshal.FreeHGlobal(data); }
      if (v.Buffer != IntPtr.Zero) { Marshal.FreeHGlobal(v.Buffer); }
      Marshal.FreeHGlobal(k.Buffer); LsaClose(h);
    }
  }
  public static string Retrieve(string key) {
    IntPtr h = Open(); U k = Str(key); IntPtr data;
    try {
      uint st = LsaRetrievePrivateData(h, ref k, out data);
      if (st == 0xC0000034) return null;
      Check(st);
      if (data == IntPtr.Zero) return null;
      U v = (U)Marshal.PtrToStructure(data, typeof(U));
      string s = Marshal.PtrToStringUni(v.Buffer, v.Length / 2);
      LsaFreeMemory(data);
      return s;
    } finally { Marshal.FreeHGlobal(k.Buffer); LsaClose(h); }
  }
}`;

// Runs elevated. Reads the encrypted blob, sets or clears automatic sign-in,
// deletes the blob and writes { ok, error, passwordLessBefore } as JSON.
const ELEVATED_PS = String.raw`
param([string]$Action, [string]$BlobFile, [string]$User, [string]$Domain, [string]$ResultFile, [string]$RestorePasswordLess)
$ErrorActionPreference = 'Stop'
$result = @{ ok = $false }
try {
  Add-Type -TypeDefinition @'
${LSA_CS}
'@
  $wl = '${WINLOGON}'
  $pl = '${PASSWORDLESS}'
  if ($Action -eq 'enable') {
    $secure = Get-Content -LiteralPath $BlobFile -Raw | ConvertTo-SecureString
    Remove-Item -LiteralPath $BlobFile -Force
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
    try { [LfLsa]::Store('DefaultPassword', [Runtime.InteropServices.Marshal]::PtrToStringUni($ptr)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr) }
    Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value '1' -Type String
    Set-ItemProperty -Path $wl -Name DefaultUserName -Value $User -Type String
    Set-ItemProperty -Path $wl -Name DefaultDomainName -Value $Domain -Type String
    Remove-ItemProperty -Path $wl -Name DefaultPassword -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $wl -Name AutoLogonCount -ErrorAction SilentlyContinue
    # "Only allow Windows Hello sign-in" (Windows 11) blocks automatic sign-in.
    if (Test-Path $pl) {
      $before = (Get-ItemProperty -Path $pl -Name DevicePasswordLessBuildVersion -ErrorAction SilentlyContinue).DevicePasswordLessBuildVersion
      if ($before -ne $null -and $before -ne 0) { $result.passwordLessBefore = $before; Set-ItemProperty -Path $pl -Name DevicePasswordLessBuildVersion -Value 0 -Type DWord }
    }
  } else {
    Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value '0' -Type String
    Remove-ItemProperty -Path $wl -Name DefaultPassword -ErrorAction SilentlyContinue
    [LfLsa]::Store('DefaultPassword', $null)
    if ($RestorePasswordLess -match '^\d+$' -and (Test-Path $pl)) { Set-ItemProperty -Path $pl -Name DevicePasswordLessBuildVersion -Value ([int]$RestorePasswordLess) -Type DWord }
  }
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
} finally {
  if ($BlobFile -and (Test-Path -LiteralPath $BlobFile)) { Remove-Item -LiteralPath $BlobFile -Force -ErrorAction SilentlyContinue }
  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8
}
`;

// Starts the elevated script: directly when this process already has
// administrator rights, else through Windows' UAC prompt.
const LAUNCH_PS = String.raw`
param([string]$Script, [string]$Arguments)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$argList = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Script + '" ' + $Arguments
if ($admin) { $p = Start-Process powershell.exe -ArgumentList $argList -WindowStyle Hidden -Wait -PassThru }
else { $p = Start-Process powershell.exe -ArgumentList $argList -Verb RunAs -WindowStyle Hidden -Wait -PassThru }
exit $p.ExitCode
`;

// Windows PowerShell 5.1 with its own module path: one inherited from
// PowerShell 7 makes its built-in commands fail to load.
function psEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  return env;
}

function ps(script, { input = '', timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout, windowsHide: true, maxBuffer: 1 << 20, env: psEnv() }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(String(stderr || err.message).trim().split('\n')[0] || 'PowerShell failed'), { code: err.code }));
      resolve(String(stdout));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function psFile(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { timeout: opts?.timeout || 180_000, windowsHide: true, env: psEnv() }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(String(stderr || err.message).trim().split('\n')[0]), { code: err.code }));
      resolve(String(stdout));
    });
  });
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// A private folder for the hand-over files.
function workDir(base) {
  const dir = path.join(base, 'autologon');
  fs.mkdirSync(dir, { recursive: true });
  return fs.mkdtempSync(path.join(dir, 'x-'));
}

async function elevated(base, action, { blob = null, user = '', domain = '', restore = '' } = {}) {
  const dir = workDir(base);
  const script = path.join(dir, 'autologon.ps1');
  const launcher = path.join(dir, 'launch.ps1');
  const blobFile = path.join(dir, 'blob.txt');
  const resultFile = path.join(dir, 'result.json');
  try {
    fs.writeFileSync(script, ELEVATED_PS, { mode: 0o600 });
    fs.writeFileSync(launcher, LAUNCH_PS, { mode: 0o600 });
    if (blob) fs.writeFileSync(blobFile, blob, { mode: 0o600 });
    const args = `-Action ${action} -BlobFile "${blobFile}" -User "${user}" -Domain "${domain}" -ResultFile "${resultFile}" -RestorePasswordLess "${restore}"`;
    try {
      await psFile(launcher, ['-Script', script, '-Arguments', args]);
    } catch (err) {
      // UAC declined (or not available).
      if (!fs.existsSync(resultFile)) return { ok: false, error: /canceled|cancelled|1223/i.test(err.message) ? 'Windows did not grant administrator rights (the prompt was declined).' : `Administrator step failed: ${err.message}` };
    }
    if (!fs.existsSync(resultFile)) return { ok: false, error: 'Windows did not grant administrator rights (the prompt was declined).' };
    const r = JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^﻿/, ''));
    if (!r.ok && /decrypt|key not valid|Key not valid/i.test(r.error || '')) r.error = 'The administrator step ran as another Windows account. Sign in to Windows with an administrator account and try again.';
    return r;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const NAME_RE = /^[^"/\\[\]:;|=,+*?<>@]{1,104}$|^[^"\s]{1,64}@[^"\s]{1,190}$/;

// enable({ user, domain, password }, { base }): base = Lead Finder's data
// folder (for the hand-over files). Returns { ok, error, passwordLessBefore }.
async function enable({ user, domain, password }, { base, platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: false, error: 'Automatic sign-in is a Windows feature.' };
  user = String(user || '').trim();
  domain = String(domain || '').trim() || os.hostname();
  if (!NAME_RE.test(user) || /["']/.test(user)) return { ok: false, error: 'Enter your Windows user name.' };
  if (!/^[\w.-]{1,64}$|^MicrosoftAccount$/i.test(domain)) return { ok: false, error: 'The computer or domain name is not valid.' };
  if (typeof password !== 'string' || !password.length || password.length > 256) return { ok: false, error: 'Enter your Windows password.' };
  // DPAPI blob of the password, for this Windows account only.
  let blob;
  try {
    blob = (await ps('$p = [Console]::In.ReadToEnd(); $p = $p.TrimEnd([char]13, [char]10); ConvertTo-SecureString -String $p -AsPlainText -Force | ConvertFrom-SecureString', { input: `${password}\n` })).trim();
  } catch (err) {
    return { ok: false, error: `Windows could not encrypt the password: ${err.message}` };
  }
  if (!/^[0-9a-f]+$/i.test(blob)) return { ok: false, error: 'Windows could not encrypt the password.' };
  return elevated(base, 'enable', { blob, user, domain });
}

async function disable({ base, restorePasswordLess = '', platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: false, error: 'Automatic sign-in is a Windows feature.' };
  return elevated(base, 'disable', { restore: /^\d+$/.test(String(restorePasswordLess)) ? String(restorePasswordLess) : '' });
}

// What Windows has now (reading needs no administrator rights).
async function status({ platform = process.platform } = {}) {
  if (platform !== 'win32') return { supported: false, enabled: false, user: '', domain: '' };
  try {
    const out = await ps(`$v = Get-ItemProperty -Path ${quote(WINLOGON)}; @{ on = [string]$v.AutoAdminLogon; user = [string]$v.DefaultUserName; domain = [string]$v.DefaultDomainName; plain = [bool]($v.PSObject.Properties.Name -contains 'DefaultPassword') } | ConvertTo-Json -Compress`, { timeout: 20_000 });
    const v = JSON.parse(out);
    return { supported: true, enabled: v.on === '1', user: v.user || '', domain: v.domain || '', plainTextPassword: Boolean(v.plain) };
  } catch (err) {
    return { supported: true, enabled: false, user: '', domain: '', error: err.message };
  }
}

// For tests on Windows (administrator): the stored secret, to compare.
async function readSecretForTest() {
  return (await ps(`Add-Type -TypeDefinition @'\n${LSA_CS}\n'@\n$s = [LfLsa]::Retrieve('DefaultPassword'); if ([string]::IsNullOrEmpty($s)) { '<none>' } else { $s }`)).trim();
}

const machineName = () => os.hostname();

module.exports = { enable, disable, status, readSecretForTest, machineName, ELEVATED_PS, LSA_CS };
