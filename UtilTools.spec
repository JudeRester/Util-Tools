# -*- mode: python ; coding: utf-8 -*-
"""
Util-Tools PyInstaller Specification File
- Mode: Standalone Directory (--onedir) for instant startup (<0.5s) & zero extraction overhead
- Bundled: Web UI, Multilingual-E5 ONNX Model, Icons, Example Templates, Native C++ DLLs
- Console: False (Windowless Tray Application)
"""
import os
import sys
from PyInstaller.utils.hooks import collect_all

block_cipher = None

# Collect ONNX Runtime & Tokenizers native binaries and data files
onnx_datas, onnx_binaries, onnx_hidden = collect_all('onnxruntime')
tok_datas, tok_binaries, tok_hidden = collect_all('tokenizers')

# Static Bundled Assets (read via sys._MEIPASS / core.paths.BUNDLE_DIR)
added_datas = [
    ('web', 'web'),
    ('utiltools.ico', '.'),
    ('*.example.json', '.'),
    ('models', 'models'),
] + onnx_datas + tok_datas

# Hidden dynamic imports required at runtime
hidden_imports = [
    'pystray._win32',
    'engineio.async_drivers.threading',
    'bottle',
    'bottle_websocket',
    'tkinter',
    'tkinter.filedialog',
    'PIL',
    'PIL.Image',
    'PIL.ImageDraw',
    'openpyxl',
    'numpy',
    'core',
    'core.paths',
    'core.tray',
    'services',
    'services.db_service',
    'services.system_service',
    'services.shortcuts_service',
    'services.quick_launch_service',
    'services.generator_service',
    'services.dialog_service',
    'services.notes_service',
    'services.calendar_service',
    'services.diagram_service',
    'services.settings_service',
    'services.backup_service',
    'services.ai_search_service',
    'services.csv_service',
    'services.markdown_service',
    'services.email_service',
    'services.mock_data_service',
] + onnx_hidden + tok_hidden

a = Analysis(
    ['main.py'],
    pathex=['.'],
    binaries=onnx_binaries + tok_binaries,
    datas=added_datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['matplotlib', 'scipy', 'torch', 'pandas', 'IPython', 'pytest', 'unittest'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='UtilTools',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='utiltools.ico'
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='UtilTools'
)
