; Inno Setup Script for Instagram Comments Automation
; Generates a 1-click standalone Setup.exe that works on ANY Windows PC or RDP!

#define MyAppName "Instagram Comments Automation"
#define MyAppVersion "2.0"
#define MyAppPublisher "Automation"
#define MyAppExeName "START.bat"
#define SourceAppDir "C:\Users\theab\OneDrive\Desktop\comments_final_automation\comments automation\comments automation"

[Setup]
AppId={{D37F29E1-8419-4C59-A8F2-72E5D4B2A014}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\Instagram Comments Automation
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=C:\Users\theab\OneDrive\Desktop
OutputBaseFilename=InstagramAutomation_Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; All core application files and scripts
Source: "{#SourceAppDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "node_modules\*,artifacts\*,install-log.txt,*.tmp"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\RDP Full Setup"; Filename: "{app}\SETUP_RDP.bat"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; 1. Auto-set TimeZone to India Standard Time (UTC+05:30)
Filename: "tzutil.exe"; Parameters: "/s ""India Standard Time"""; Flags: runhidden

; 2. Open Windows Firewall for SMM API Port 4620
Filename: "netsh.exe"; Parameters: "advfirewall firewall add rule name=""SMM API 4620"" dir=in action=allow protocol=TCP localport=4620"; Flags: runhidden

; 3. Run 1-Click RDP Setup and launch application
Filename: "{app}\SETUP_RDP.bat"; Description: "Complete dependencies setup and launch automation"; Flags: postinstall shellexec
