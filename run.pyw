"""
Utility Toolkit - Windowless Launcher (콘솔 창 없는 백그라운드 실행기)
Windows에서 이 파일을 더블 클릭하면 검은색 CMD 창 없이 백그라운드 시스템 트레이로 바로 실행됩니다.
"""
import sys
import os

# 현재 경로를 sys.path에 추가
base_dir = os.path.dirname(os.path.abspath(__file__))
if base_dir not in sys.path:
    sys.path.insert(0, base_dir)

import main

if __name__ == '__main__':
    main.main()
