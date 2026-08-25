"""
Markdown 파일 뷰어 및 에디터 백엔드 서비스 모듈
- 인코딩 자동 감지 (UTF-8, CP949/EUC-KR, Latin-1)
- 파일 열기 및 저장 대화상자 (Tkinter)
"""
import os
import io
import eel


def _detect_encoding_and_read(file_path):
    """파일의 인코딩을 안전하게 감지하여 텍스트 및 인코딩명 반환"""
    encodings_to_try = ['utf-8-sig', 'utf-8', 'cp949', 'euc-kr', 'latin-1']
    
    with open(file_path, 'rb') as f:
        raw_bytes = f.read()

    for enc in encodings_to_try:
        try:
            text = raw_bytes.decode(enc)
            return text, enc
        except UnicodeDecodeError:
            continue

    return raw_bytes.decode('utf-8', errors='replace'), 'utf-8 (fallback)'


@eel.expose
def select_and_read_markdown_file():
    """탐색기 파일 대화상자를 열어 Markdown/텍스트 파일을 읽고 내용 반환"""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        file_selected = filedialog.askopenfilename(
            title='열람할 Markdown / 텍스트 문서 선택',
            filetypes=[
                ('Markdown 파일 (*.md;*.markdown;*.mdown;*.mkd)', '*.md;*.markdown;*.mdown;*.mkd'),
                ('텍스트 파일 (*.txt)', '*.txt'),
                ('모든 파일 (*.*)', '*.*')
            ]
        )
        root.destroy()

        if not file_selected:
            return {'status': 'cancelled'}

        file_selected = os.path.normpath(file_selected)
        return read_markdown_from_path(file_selected)

    except Exception as e:
        return {'status': 'error', 'message': f'파일 선택 중 오류 발생: {str(e)}'}


@eel.expose
def read_markdown_from_path(file_path):
    """지정된 파일 경로에서 Markdown 텍스트를 읽어 반환"""
    try:
        if not os.path.exists(file_path):
            return {'status': 'error', 'message': f'파일을 찾을 수 없습니다: {file_path}'}

        file_size = os.path.getsize(file_path)
        file_name = os.path.basename(file_path)
        text, encoding_used = _detect_encoding_and_read(file_path)

        return {
            'status': 'success',
            'file_name': file_name,
            'file_path': file_path,
            'file_size': file_size,
            'encoding': encoding_used,
            'content': text
        }
    except Exception as e:
        return {'status': 'error', 'message': f'Markdown 파일 읽기 실패: {str(e)}'}


@eel.expose
def save_markdown_to_file(raw_content, default_filename='document.md'):
    """파일 저장 대화상자를 열어 Markdown 텍스트를 파일로 저장 (UTF-8)"""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        save_path = filedialog.asksaveasfilename(
            title='Markdown 파일 저장',
            initialfile=default_filename,
            defaultextension='.md',
            filetypes=[
                ('Markdown 문서 (*.md)', '*.md'),
                ('텍스트 파일 (*.txt)', '*.txt'),
                ('모든 파일 (*.*)', '*.*')
            ]
        )
        root.destroy()

        if not save_path:
            return {'status': 'cancelled'}

        save_path = os.path.normpath(save_path)
        with open(save_path, 'w', encoding='utf-8', newline='') as f:
            f.write(raw_content)

        return {
            'status': 'success',
            'path': save_path,
            'file_name': os.path.basename(save_path)
        }
    except Exception as e:
        return {'status': 'error', 'message': f'파일 저장 실패: {str(e)}'}
