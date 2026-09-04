"""
Util-Tools - Dynamic Code Integrity & Verification Harness
=============================================================================
자동 파일 탐색(Dynamic Discovery) 및 서비스 인트로스펙션(Introspection) 기반의
원스톱 무결성 검증 도구입니다.

프로젝트 내에 신규 Python(.py, .pyw) 파일 또는 JS(.js) 파일이 추가되더라도
본 스크립트를 수정할 필요 없이 100% 동적으로 자동 탐색 및 검증합니다.

검증 항목:
1. Python 전수 구문 분석 (py_compile)
2. 백엔드 서비스 레이어 동적 임포트 & SQLite DB 무결성 검증 (services/*.py, init_db)
3. 프론트엔드 JavaScript 전수 문법 검사 (node -c)
4. CSS 스타일시트 구조 및 괄호 짝 검증 (web/style.css)
5. 코어 진입점 및 시스템 트레이 무결성 검증 (TrayManager)
=============================================================================
"""

import sys
import os
import time
import re
import argparse
import subprocess
import importlib
import py_compile
from pathlib import Path

# Windows 콘솔 UTF-8 출력 보장
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# 0. 중앙 경로 관리자 로드
_SCRIPT_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _SCRIPT_DIR.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

try:
    from core.paths import BASE_DIR, BUNDLE_DIR, DATA_DIR, WEB_DIR, DB_PATH
except ImportError:
    BASE_DIR = _PROJECT_ROOT
    BUNDLE_DIR = _PROJECT_ROOT
    DATA_DIR = _PROJECT_ROOT / "data"
    WEB_DIR = _PROJECT_ROOT / "web"
    DB_PATH = DATA_DIR / "app.db"

# 자동 제외 대상 디렉토리
EXCLUDE_DIRS = {
    ".git",
    "__pycache__",
    "venv",
    "env",
    ".venv",
    "build",
    "dist",
    "data",
    "models",
    "emails",
    ".system_generated",
    "brain",
    ".agents",
}

# ANSI 컬러 상수
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


class VerificationReporter:
    """검증 단계 및 결과 출력기"""

    def __init__(self, verbose=False):
        self.verbose = verbose
        self.steps = []
        self.start_time = time.perf_counter()

    def print_banner(self):
        print(f"\n{BOLD}{CYAN}===================================================================={RESET}")
        print(f"{BOLD}{CYAN}   🛠️  Util-Tools Code Integrity Verification Harness (Dynamic)     {RESET}")
        print(f"{BOLD}{CYAN}===================================================================={RESET}")
        print(f"{DIM}Root Directory: {BASE_DIR}{RESET}\n")

    def record_step(self, step_no, name, status, duration_ms, details=""):
        self.steps.append({
            "step": step_no,
            "name": name,
            "status": status,
            "duration_ms": duration_ms,
            "details": details
        })
        status_badge = f"{GREEN}[ PASS ]{RESET}" if status else f"{RED}[ FAIL ]{RESET}"
        time_str = f"{duration_ms:.1f}ms"
        print(f"{status_badge} {BOLD}Step {step_no}: {name}{RESET} {DIM}({time_str}){RESET}")
        if details:
            for line in details.strip().splitlines():
                print(f"         {line}")

    def print_summary(self):
        total_duration = (time.perf_counter() - self.start_time) * 1000
        all_passed = all(s["status"] for s in self.steps)

        print(f"\n{BOLD}{CYAN}--------------------------------------------------------------------{RESET}")
        if all_passed:
            print(f"{BOLD}{GREEN}  ✨ ALL VERIFICATION CHECKS PASSED SUCCESSFULLY ({len(self.steps)}/{len(self.steps)}){RESET}")
        else:
            failed_count = sum(1 for s in self.steps if not s["status"])
            print(f"{BOLD}{RED}  ❌ VERIFICATION FAILED: {failed_count} step(s) encountered errors{RESET}")
        print(f"{DIM}  Total Execution Time: {total_duration:.1f}ms{RESET}")
        print(f"{BOLD}{CYAN}===================================================================={RESET}\n")
        return 0 if all_passed else 1


def find_all_python_files(root: Path) -> list[Path]:
    """검증 제외 디렉토리를 배제하고 프로젝트 내 모든 .py / .pyw 파일을 동적 탐색"""
    py_files = []
    for path in root.rglob("*"):
        if path.suffix in (".py", ".pyw"):
            if not any(ex in path.parts for ex in EXCLUDE_DIRS):
                py_files.append(path)
    return sorted(py_files)


def find_all_js_files(web_dir: Path) -> list[Path]:
    """web/js/ 디렉토리 내 모든 .js 파일을 동적 탐색"""
    js_dir = web_dir / "js"
    if not js_dir.exists():
        return []
    return sorted(list(js_dir.glob("*.js")))


def verify_python_syntax(files: list[Path], reporter: VerificationReporter) -> bool:
    """1단계: 프로젝트 내 모든 Python 파일 전수 컴파일 검증"""
    t0 = time.perf_counter()
    errors = []

    for f in files:
        rel_path = f.relative_to(BASE_DIR)
        if reporter.verbose:
            print(f"  {DIM}Compiling: {rel_path}{RESET}")
        try:
            py_compile.compile(str(f), doraise=True)
        except py_compile.PyCompileError as e:
            errors.append(f"{rel_path}: {e}")
        except Exception as e:
            errors.append(f"{rel_path}: {e}")

    duration_ms = (time.perf_counter() - t0) * 1000
    if not errors:
        reporter.record_step(
            1,
            "Python Dynamic Syntax Check",
            True,
            duration_ms,
            f"Compiled {len(files)} Python files (.py/.pyw) across codebase"
        )
        return True
    else:
        err_msg = "\n".join(f"{RED}Error:{RESET} {err}" for err in errors)
        reporter.record_step(1, "Python Dynamic Syntax Check", False, duration_ms, err_msg)
        return False


def verify_services_introspection(reporter: VerificationReporter) -> bool:
    """2단계: services/ 내 모든 모듈 동적 임포트 및 SQLite DB 초기화 검증"""
    t0 = time.perf_counter()
    errors = []
    services_dir = BASE_DIR / "services"
    service_files = sorted([f for f in services_dir.glob("*.py") if f.name != "__init__.py"])

    imported_modules = []
    for f in service_files:
        module_name = f"services.{f.stem}"
        if reporter.verbose:
            print(f"  {DIM}Introspecting: {module_name}{RESET}")
        try:
            mod = importlib.import_module(module_name)
            imported_modules.append(module_name)
        except Exception as e:
            errors.append(f"Failed to import {module_name}: {e}")

    # SQLite DB 초기화 검증
    try:
        import services.db_service as db_service
        db_service.init_db()
        with db_service.get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT count(*) FROM sqlite_master WHERE type='table'")
            table_count = cursor.fetchone()[0]
    except Exception as e:
        errors.append(f"SQLite DB init_db() failed: {e}")
        table_count = 0

    duration_ms = (time.perf_counter() - t0) * 1000
    if not errors:
        reporter.record_step(
            2,
            "Backend Services Introspection & SQLite DB",
            True,
            duration_ms,
            f"Introspected {len(imported_modules)} services, SQLite verified ({table_count} tables active)"
        )
        return True
    else:
        err_msg = "\n".join(f"{RED}Error:{RESET} {err}" for err in errors)
        reporter.record_step(2, "Backend Services Introspection & SQLite DB", False, duration_ms, err_msg)
        return False


def verify_javascript_syntax(files: list[Path], reporter: VerificationReporter) -> bool:
    """3단계: web/js/ 내 모든 JS 모듈 Node.js 구문 분석 검증"""
    t0 = time.perf_counter()
    errors = []

    for f in files:
        rel_path = f.relative_to(BASE_DIR)
        if reporter.verbose:
            print(f"  {DIM}Checking JS: {rel_path}{RESET}")
        try:
            res = subprocess.run(
                ["node", "-c", str(f)],
                capture_output=True,
                text=True,
                check=False
            )
            if res.returncode != 0:
                err_text = res.stderr.strip() or res.stdout.strip()
                errors.append(f"{rel_path}:\n{err_text}")
        except FileNotFoundError:
            errors.append("Node.js binary ('node') not found on system PATH")
            break
        except Exception as e:
            errors.append(f"{rel_path}: {e}")

    duration_ms = (time.perf_counter() - t0) * 1000
    if not errors:
        reporter.record_step(
            3,
            "Frontend JavaScript Syntax (node -c)",
            True,
            duration_ms,
            f"Checked {len(files)} JavaScript modules in web/js/"
        )
        return True
    else:
        err_msg = "\n".join(f"{RED}Error:{RESET} {err}" for err in errors)
        reporter.record_step(3, "Frontend JavaScript Syntax (node -c)", False, duration_ms, err_msg)
        return False


def verify_css_syntax(reporter: VerificationReporter) -> bool:
    """4단계: web/style.css 중괄호 짝 일치 및 파싱 검증"""
    t0 = time.perf_counter()
    css_path = BASE_DIR / "web" / "style.css"

    if not css_path.exists():
        duration_ms = (time.perf_counter() - t0) * 1000
        reporter.record_step(4, "Stylesheet Structure & Braces", False, duration_ms, f"CSS file not found: {css_path}")
        return False

    try:
        content = css_path.read_text(encoding="utf-8")
        clean_content = re.sub(r"/\*.*?\*/", "", content, flags=re.DOTALL)
        open_braces = clean_content.count("{")
        close_braces = clean_content.count("}")
        line_count = len(content.splitlines())

        if open_braces != close_braces:
            duration_ms = (time.perf_counter() - t0) * 1000
            err_msg = f"CSS brace mismatch! Opening '{{' count: {open_braces}, Closing '}}' count: {close_braces}"
            reporter.record_step(4, "Stylesheet Structure & Braces", False, duration_ms, err_msg)
            return False

        duration_ms = (time.perf_counter() - t0) * 1000
        reporter.record_step(
            4,
            "Stylesheet Structure & Braces",
            True,
            duration_ms,
            f"Balanced {open_braces} CSS rule blocks across {line_count} lines"
        )
        return True
    except Exception as e:
        duration_ms = (time.perf_counter() - t0) * 1000
        reporter.record_step(4, "Stylesheet Structure & Braces", False, duration_ms, f"CSS read error: {e}")
        return False


def verify_core_entrypoint(reporter: VerificationReporter) -> bool:
    """5단계: TrayManager 및 시스템 트레이 무결성 검증"""
    t0 = time.perf_counter()
    try:
        from core.tray import TrayManager
        tm = TrayManager(BUNDLE_DIR)
        tray_img = tm.get_tray_image()
        if tray_img is None:
            duration_ms = (time.perf_counter() - t0) * 1000
            reporter.record_step(5, "Core Entrypoint & System Tray", False, duration_ms, "TrayManager.get_tray_image() returned None")
            return False

        duration_ms = (time.perf_counter() - t0) * 1000
        reporter.record_step(
            5,
            "Core Entrypoint & System Tray",
            True,
            duration_ms,
            f"TrayManager instantiated, icon loaded: {tray_img.size} ({tray_img.mode})"
        )
        return True
    except Exception as e:
        duration_ms = (time.perf_counter() - t0) * 1000
        reporter.record_step(5, "Core Entrypoint & System Tray", False, duration_ms, f"TrayManager failure: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Util-Tools Dynamic Code Integrity & Verification Harness",
        formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Print details for every file inspected")
    parser.add_argument("--step", type=int, choices=[1, 2, 3, 4, 5], help="Run only a specific verification step")
    args = parser.parse_args()

    reporter = VerificationReporter(verbose=args.verbose)
    reporter.print_banner()

    # 동적 파일 탐색
    py_files = find_all_python_files(BASE_DIR)
    js_files = find_all_js_files(WEB_DIR)

    if args.step is not None:
        if args.step == 1:
            verify_python_syntax(py_files, reporter)
        elif args.step == 2:
            verify_services_introspection(reporter)
        elif args.step == 3:
            verify_javascript_syntax(js_files, reporter)
        elif args.step == 4:
            verify_css_syntax(reporter)
        elif args.step == 5:
            verify_core_entrypoint(reporter)
    else:
        # 전체 5단계 실행
        verify_python_syntax(py_files, reporter)
        verify_services_introspection(reporter)
        verify_javascript_syntax(js_files, reporter)
        verify_css_syntax(reporter)
        verify_core_entrypoint(reporter)

    exit_code = reporter.print_summary()
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
