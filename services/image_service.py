"""
이미지 슬라이서 및 분할 처리 백엔드 서비스 모듈 (services/image_service.py)
- PIL(Pillow) 기반 무손실 고품질 이미지 자르기 (Crop & Slice)
- 지정 폴더 일괄 파일 저장 및 ZIP 압축 내보내기
- 수평 단색 여백(Whitespace Gap) 자동 감지
- 탐색기 파일/폴더 선택 대화상자 지원
"""
import os
import io
import base64
import zipfile
import datetime
import eel
from PIL import Image, ImageStat
import core.logger


def _decode_base64_image(image_data_base64: str) -> Image.Image:
    """Base64 데이터 URL 또는 순수 Base64 문자열을 PIL Image 객체로 디코딩"""
    if ',' in image_data_base64:
        image_data_base64 = image_data_base64.split(',', 1)[1]
    
    img_bytes = base64.b64decode(image_data_base64)
    img = Image.open(io.BytesIO(img_bytes))
    return img


@eel.expose
def pick_image_file():
    """탐색기 파일 대화상자를 열어 이미지 파일 선택"""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        file_path = filedialog.askopenfilename(
            title='슬라이스할 이미지 파일 선택',
            filetypes=[
                ('이미지 파일 (*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif)', '*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif'),
                ('PNG 파일 (*.png)', '*.png'),
                ('JPEG 파일 (*.jpg;*.jpeg)', '*.jpg;*.jpeg'),
                ('WebP 파일 (*.webp)', '*.webp'),
                ('모든 파일 (*.*)', '*.*')
            ]
        )
        root.destroy()

        if not file_path:
            return {'status': 'cancelled'}

        file_path = os.path.normpath(file_path)
        return load_image_from_path(file_path)
    except Exception as e:
        core.logger.log_error("Image Slicer", f"이미지 선택 실패: {e}", exc=e)
        return {'status': 'error', 'message': f'이미지 선택 오류: {str(e)}'}


@eel.expose
def pick_output_folder():
    """탐색기 폴더 선택 대화상자"""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        folder_path = filedialog.askdirectory(title='슬라이스 조각들을 저장할 대상 폴더 선택')
        root.destroy()

        if not folder_path:
            return {'status': 'cancelled'}

        folder_path = os.path.normpath(folder_path)
        return {'status': 'success', 'folder_path': folder_path}
    except Exception as e:
        core.logger.log_error("Image Slicer", f"폴더 선택 실패: {e}", exc=e)
        return {'status': 'error', 'message': f'폴더 선택 오류: {str(e)}'}


@eel.expose
def load_image_from_path(file_path: str):
    """로컬 이미지 파일 경로에서 읽어 base64 및 메타데이터 반환"""
    try:
        if not os.path.exists(file_path):
            return {'status': 'error', 'message': f'파일을 찾을 수 없습니다: {file_path}'}

        file_size = os.path.getsize(file_path)
        file_name = os.path.basename(file_path)

        with Image.open(file_path) as img:
            width, height = img.size
            img_format = (img.format or 'PNG').lower()
            
            # RGB/RGBA 변환 유지
            buffered = io.BytesIO()
            save_fmt = 'PNG' if img_format in ('png', 'webp', 'gif') else 'JPEG'
            img.save(buffered, format=save_fmt)
            img_b64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
            mime = f"image/{save_fmt.lower()}"

        return {
            'status': 'success',
            'file_name': file_name,
            'file_path': file_path,
            'file_size': file_size,
            'width': width,
            'height': height,
            'format': img_format,
            'data_url': f"data:{mime};base64,{img_b64}"
        }
    except Exception as e:
        core.logger.log_error("Image Slicer", f"이미지 파일 로드 실패: {e}", exc=e)
        return {'status': 'error', 'message': f'이미지 열기 실패: {str(e)}'}


@eel.expose
def detect_image_gaps(image_data_base64: str, min_gap_height: int = 15, variance_threshold: float = 3.0):
    """
    이미지 내의 수평 단색 여백(Horizontal Blank Gap) 영역을 자동 감지하여 추천 Y 절단선 목록 반환
    """
    try:
        img = _decode_base64_image(image_data_base64).convert('L')
        width, height = img.size

        # 각 행(Row)별 표준편차/분산 측정
        # 분산이 매우 낮으면 해당 행은 단색/균일한 배경으로 판별
        is_blank_row = []
        for y in range(height):
            box = (0, y, width, y + 1)
            row_crop = img.crop(box)
            stat = ImageStat.Stat(row_crop)
            stddev = stat.stddev[0] if stat.stddev else 0
            is_blank_row.append(stddev < variance_threshold)

        # 연속된 여백 구간(Gap) 추출
        gaps = []
        in_gap = False
        gap_start = 0

        for y in range(height):
            if is_blank_row[y]:
                if not in_gap:
                    in_gap = True
                    gap_start = y
            else:
                if in_gap:
                    in_gap = False
                    gap_len = y - gap_start
                    if gap_len >= min_gap_height:
                        # 여백의 정중앙을 절단선 좌표로 제안
                        mid_y = gap_start + (gap_len // 2)
                        # 이미지 상단/하단 경계(0, height) 부근 제외
                        if 5 < mid_y < height - 5:
                            gaps.append(mid_y)

        # 마지막 여백 처리
        if in_gap:
            gap_len = height - gap_start
            if gap_len >= min_gap_height:
                mid_y = gap_start + (gap_len // 2)
                if 5 < mid_y < height - 5:
                    gaps.append(mid_y)

        core.logger.log_info("Image Slicer", f"여백 자동 감지 완료: {len(gaps)}개의 절단선 자동 추천 (이미지 높이: {height}px)")
        return {
            'status': 'success',
            'cut_lines_y': gaps,
            'count': len(gaps),
            'image_height': height
        }
    except Exception as e:
        core.logger.log_error("Image Slicer", f"여백 자동 감지 실패: {e}", exc=e)
        return {'status': 'error', 'message': f'여백 감지 실패: {str(e)}'}


@eel.expose
def slice_and_save_to_folder(image_data_base64: str, slice_boxes: list, folder_path: str = '', prefix: str = 'slice', output_format: str = 'png', quality: int = 95):
    """
    이미지를 지정된 slice_boxes [[x, y, w, h], ...] 좌표에 따라 잘라 지정 폴더에 일괄 저장
    """
    try:
        if not folder_path:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes('-topmost', True)
            folder_path = filedialog.askdirectory(title='슬라이스 조각들을 저장할 대상 폴더 선택')
            root.destroy()

            if not folder_path:
                return {'status': 'cancelled'}

        folder_path = os.path.normpath(folder_path)
        os.makedirs(folder_path, exist_ok=True)

        img = _decode_base64_image(image_data_base64)
        total_slices = len(slice_boxes)
        saved_files = []

        ext = output_format.lower()
        if ext == 'jpeg':
            ext = 'jpg'

        digits = max(2, len(str(total_slices)))

        for idx, box in enumerate(slice_boxes, start=1):
            x, y, w, h = box
            # 픽셀 좌표 정수형 변환 및 경계 클램핑
            x1 = max(0, int(round(x)))
            y1 = max(0, int(round(y)))
            x2 = min(img.width, int(round(x + w)))
            y2 = min(img.height, int(round(y + h)))

            if x2 <= x1 or y2 <= y1:
                continue

            crop_piece = img.crop((x1, y1, x2, y2))
            filename = f"{prefix}_{str(idx).zfill(digits)}.{ext}"
            file_dest = os.path.join(folder_path, filename)

            save_params = {}
            if ext in ('jpg', 'jpeg'):
                if crop_piece.mode in ('RGBA', 'LA', 'P'):
                    # 알파 채널 흰색 배경 합성
                    bg = Image.new('RGB', crop_piece.size, (255, 255, 255))
                    bg.paste(crop_piece, mask=crop_piece.split()[-1] if crop_piece.mode == 'RGBA' else None)
                    crop_piece = bg
                save_params['quality'] = quality
            elif ext == 'webp':
                save_params['quality'] = quality

            crop_piece.save(file_dest, **save_params)
            saved_files.append(file_dest)

        core.logger.log_info("Image Slicer", f"총 {len(saved_files)}개 조각 저장 완료 -> {folder_path}")
        return {
            'status': 'success',
            'count': len(saved_files),
            'folder_path': folder_path,
            'files': saved_files
        }
    except Exception as e:
        core.logger.log_error("Image Slicer", f"슬라이스 파일 저장 실패: {e}", exc=e)
        return {'status': 'error', 'message': f'슬라이스 저장 실패: {str(e)}'}


@eel.expose
def slice_and_export_zip(image_data_base64: str, slice_boxes: list, default_zip_name: str = 'slices.zip', prefix: str = 'slice', output_format: str = 'png', quality: int = 95):
    """
    모든 슬라이스 조각들을 메모리에서 잘라 단일 ZIP 아카이브 파일로 저장
    """
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        zip_save_path = filedialog.asksaveasfilename(
            title='슬라이스 압축 ZIP 파일 저장',
            initialfile=default_zip_name if default_zip_name.endswith('.zip') else f"{default_zip_name}.zip",
            defaultextension='.zip',
            filetypes=[('ZIP 압축 파일 (*.zip)', '*.zip'), ('모든 파일 (*.*)', '*.*')]
        )
        root.destroy()

        if not zip_save_path:
            return {'status': 'cancelled'}

        zip_save_path = os.path.normpath(zip_save_path)
        img = _decode_base64_image(image_data_base64)
        total_slices = len(slice_boxes)
        digits = max(2, len(str(total_slices)))

        ext = output_format.lower()
        if ext == 'jpeg':
            ext = 'jpg'

        with zipfile.ZipFile(zip_save_path, 'w', compression=zipfile.ZIP_DEFLATED) as zipf:
            for idx, box in enumerate(slice_boxes, start=1):
                x, y, w, h = box
                x1 = max(0, int(round(x)))
                y1 = max(0, int(round(y)))
                x2 = min(img.width, int(round(x + w)))
                y2 = min(img.height, int(round(y + h)))

                if x2 <= x1 or y2 <= y1:
                    continue

                crop_piece = img.crop((x1, y1, x2, y2))
                filename = f"{prefix}_{str(idx).zfill(digits)}.{ext}"

                buf = io.BytesIO()
                save_params = {}
                if ext in ('jpg', 'jpeg'):
                    if crop_piece.mode in ('RGBA', 'LA', 'P'):
                        bg = Image.new('RGB', crop_piece.size, (255, 255, 255))
                        bg.paste(crop_piece, mask=crop_piece.split()[-1] if crop_piece.mode == 'RGBA' else None)
                        crop_piece = bg
                    save_params['quality'] = quality
                elif ext == 'webp':
                    save_params['quality'] = quality

                crop_piece.save(buf, format='PNG' if ext == 'png' else 'JPEG' if ext == 'jpg' else 'WEBP', **save_params)
                zipf.writestr(filename, buf.getvalue())

        core.logger.log_info("Image Slicer", f"ZIP 압축 파일 저장 완료 ({total_slices}개 조각) -> {zip_save_path}")
        return {
            'status': 'success',
            'count': total_slices,
            'zip_path': zip_save_path,
            'file_name': os.path.basename(zip_save_path)
        }
    except Exception as e:
        core.logger.log_error("Image Slicer", f"ZIP 내보내기 실패: {e}", exc=e)
        return {'status': 'error', 'message': f'ZIP 내보내기 실패: {str(e)}'}
