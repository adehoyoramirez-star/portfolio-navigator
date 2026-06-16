\$src = "C:\Users\marti\Desktop\PAPA\portfolio-navigator\Heatmap Regression"
\$desktop = [Environment]::GetFolderPath("Desktop")
\$w = New-Object -ComObject WScript.Shell
\$lnk = \$w.CreateShortcut(\$desktop + "\Olympus PIPELINE (CMD).lnk")
\$lnk.TargetPath = "cmd.exe"
\$lnk.Arguments = "/c cd /d "" + \$src + "" && call ejecutar_diario.bat"
\$lnk.WorkingDirectory = \$src
\$lnk.Save()
\$lnk2 = \$w.CreateShortcut(\$desktop + "\Olympus PIPELINE (PowerShell).lnk")
\$lnk2.TargetPath = "powershell.exe"
\$lnk2.Arguments = "-ExecutionPolicy Bypass -File "" + \$src + "jecutar_diario.ps1""
\$lnk2.WorkingDirectory = \$src
\$lnk2.Save()
Write-Host "ACCESOS_CREADOS"
