@echo off
chcp 65001 >nul
setlocal
cd /d %~dp0

set NODE=C:\Users\Typhoon\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
set JAVA_HOME=C:\Program Files\Java\jdk-21
set ANDROID_HOME=C:\Users\Typhoon\AppData\Local\Android\Sdk

echo [1/3] 同步 web 资源到 www ...
"%NODE%" sync-web.js || goto :fail

echo [2/3] Capacitor sync ...
"%NODE%" node_modules\@capacitor\cli\bin\capacitor sync android || goto :fail

echo [3/3] Gradle 构建 APK ...
cd android
call gradlew.bat assembleDebug || goto :fail
cd ..

copy /y android\app\build\outputs\apk\debug\app-debug.apk "..\B站历史记录仪-手机版.apk" >nul
echo.
echo 完成！APK 已更新到：bili-history\B站历史记录仪-手机版.apk
pause
exit /b 0

:fail
echo.
echo 构建失败，请检查上方错误信息。
pause
exit /b 1
