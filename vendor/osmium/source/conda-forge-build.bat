setlocal EnableDelayedExpansion


set BUILD_DIR=build

cd %SRC_DIR%

mkdir %BUILD_DIR%

if exist "%SRC_DIR%\contrib" rd /s /q "%SRC_DIR%\contrib"

cmake %CMAKE_ARGS% -S . ^
 -B %BUILD_DIR% ^
 -G "Ninja" ^
 -D CMAKE_BUILD_TYPE=Release ^
 -D CMAKE_INSTALL_PREFIX="%LIBRARY_PREFIX%"

if errorlevel 1 exit 1

cmake --build %BUILD_DIR% --target all

if errorlevel 1 exit 1

cmake --build %BUILD_DIR% --target install

if errorlevel 1 exit 1
