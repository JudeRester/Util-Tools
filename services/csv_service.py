"""
CSV / TSV / 테이블 데이터 뷰어 백엔드 서비스 모듈
- 인코딩 자동 감지 (UTF-8, UTF-8-BOM, CP949/EUC-KR, Latin-1)
- 구분자 자동 감지 (쉼표, 탭, 세미콜론, 파이프)
- 대화상자 파일 열기 및 저장 지원
"""
import os
import csv
import io
import eel


def _detect_encoding_and_read(file_path):
    """파일의 인코딩(UTF-8, CP949 등)을 안전하게 감지하여 텍스트 및 인코딩명 반환"""
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


def _detect_delimiter(sample_text):
    """텍스트 샘플을 기반으로 가장 적합한 구분자 판별"""
    if not sample_text:
        return ','
    
    lines = [line.strip() for line in sample_text.splitlines()[:15] if line.strip()]
    if not lines:
        return ','

    sample_chunk = '\n'.join(lines)
    try:
        sniffer = csv.Sniffer()
        dialect = sniffer.sniff(sample_chunk, delimiters=[',', '\t', ';', '|'])
        return dialect.delimiter
    except Exception:
        pass

    delimiters = [',', '\t', ';', '|']
    counts = {d: sum(line.count(d) for line in lines) for d in delimiters}
    best_delimiter = max(counts, key=counts.get)
    return best_delimiter if counts[best_delimiter] > 0 else ','


def _parse_csv_lines(text, delimiter=None):
    """문자열 텍스트를 파싱하여 headers와 rows 2차원 리스트 반환"""
    if not text or not text.strip():
        return [], [], ','

    if not delimiter or delimiter == 'auto':
        delimiter = _detect_delimiter(text)

    f = io.StringIO(text)
    reader = csv.reader(f, delimiter=delimiter)
    
    all_rows = []
    for row in reader:
        if not row or all(cell == '' for cell in row):
            continue
        all_rows.append(row)

    if not all_rows:
        return [], [], delimiter

    headers = all_rows[0]
    rows = all_rows[1:]

    max_cols = max(len(headers), max((len(r) for r in rows), default=0))
    if len(headers) < max_cols:
        headers.extend([f'열_{i+1}' for i in range(len(headers), max_cols)])

    normalized_rows = []
    for r in rows:
        if len(r) < max_cols:
            r = r + [''] * (max_cols - len(r))
        elif len(r) > max_cols:
            r = r[:max_cols]
        normalized_rows.append(r)

    return headers, normalized_rows, delimiter


@eel.expose
def select_and_read_csv_file():
    """탐색기 파일 대화상자를 열어 CSV/TSV 파일을 읽고 파싱된 데이터 반환"""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        file_selected = filedialog.askopenfilename(
            title='열람할 CSV / TSV 데이터 파일 선택',
            filetypes=[
                ('CSV / TSV / 텍스트 파일', '*.csv;*.tsv;*.txt;*.tab;*.dat'),
                ('CSV 파일 (*.csv)', '*.csv'),
                ('TSV / 탭 구분 파일 (*.tsv;*.tab;*.txt)', '*.tsv;*.tab;*.txt'),
                ('모든 파일 (*.*)', '*.*')
            ]
        )
        root.destroy()

        if not file_selected:
            return {'status': 'cancelled'}

        file_selected = os.path.normpath(file_selected)
        return read_csv_from_path(file_selected)

    except Exception as e:
        return {'status': 'error', 'message': f'파일 선택 중 오류 발생: {str(e)}'}


@eel.expose
def read_csv_from_path(file_path, forced_encoding='auto', forced_delimiter='auto'):
    """지정된 파일 경로에서 CSV를 읽어 파싱하여 반환"""
    try:
        if not os.path.exists(file_path):
            return {'status': 'error', 'message': f'파일을 찾을 수 없습니다: {file_path}'}

        file_size = os.path.getsize(file_path)
        file_name = os.path.basename(file_path)

        if forced_encoding and forced_encoding != 'auto':
            try:
                with open(file_path, 'r', encoding=forced_encoding, errors='replace') as f:
                    text = f.read()
                encoding_used = forced_encoding
            except Exception:
                text, encoding_used = _detect_encoding_and_read(file_path)
        else:
            text, encoding_used = _detect_encoding_and_read(file_path)

        delimiter_to_use = None if forced_delimiter == 'auto' else forced_delimiter
        headers, rows, detected_delimiter = _parse_csv_lines(text, delimiter=delimiter_to_use)

        return {
            'status': 'success',
            'file_name': file_name,
            'file_path': file_path,
            'file_size': file_size,
            'encoding': encoding_used,
            'delimiter': detected_delimiter,
            'headers': headers,
            'rows': rows,
            'total_rows': len(rows),
            'total_cols': len(headers)
        }
    except Exception as e:
        return {'status': 'error', 'message': f'CSV 파일 읽기 실패: {str(e)}'}


@eel.expose
def parse_raw_csv_text(raw_text, forced_delimiter='auto'):
    """클립보드 또는 드롭된 원시 텍스트를 CSV로 파싱"""
    try:
        if not raw_text or not raw_text.strip():
            return {'status': 'error', 'message': '파싱할 데이터가 비어 있습니다.'}

        delimiter_to_use = None if forced_delimiter == 'auto' else forced_delimiter
        headers, rows, detected_delimiter = _parse_csv_lines(raw_text, delimiter=delimiter_to_use)

        return {
            'status': 'success',
            'file_name': '클립보드 데이터 (Pasted Data)',
            'file_path': '',
            'file_size': len(raw_text.encode('utf-8')),
            'encoding': 'utf-8',
            'delimiter': detected_delimiter,
            'headers': headers,
            'rows': rows,
            'total_rows': len(rows),
            'total_cols': len(headers)
        }
    except Exception as e:
        return {'status': 'error', 'message': f'텍스트 파싱 실패: {str(e)}'}


@eel.expose
def save_csv_to_file(raw_content, default_filename='export.csv'):
    """파일 저장 대화상자를 열어 CSV 텍스트를 파일로 저장 (UTF-8 with BOM for Excel)"""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        save_path = filedialog.asksaveasfilename(
            title='CSV 파일 저장',
            initialfile=default_filename,
            defaultextension='.csv',
            filetypes=[
                ('CSV 파일 (*.csv)', '*.csv'),
                ('TSV 파일 (*.tsv)', '*.tsv'),
                ('모든 파일 (*.*)', '*.*')
            ]
        )
        root.destroy()

        if not save_path:
            return {'status': 'cancelled'}

        save_path = os.path.normpath(save_path)
        with open(save_path, 'w', encoding='utf-8-sig', newline='') as f:
            f.write(raw_content)

        return {
            'status': 'success',
            'path': save_path,
            'file_name': os.path.basename(save_path)
        }
    except Exception as e:
        return {'status': 'error', 'message': f'파일 저장 실패: {str(e)}'}
