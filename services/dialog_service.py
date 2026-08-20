"""
Tkinter 기반 파일/폴더 선택 대화상자(Dialog) 서비스 모듈
"""
import os
import eel


@eel.expose
def select_folder_dialog():
    """폴더 선택 대화상자 열기 (tkinter)"""
    try:
        import tkinter as tk
        from tkinter import filedialog
        
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        folder_selected = filedialog.askdirectory(title="숏컷으로 등록할 폴더 선택")
        root.destroy()
        
        if folder_selected:
            folder_selected = os.path.normpath(folder_selected)
            return {"status": "success", "path": folder_selected}
        return {"status": "cancelled", "path": ""}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def select_file_dialog():
    """실행할 파일 선택 대화상자 열기 (tkinter)"""
    try:
        import tkinter as tk
        from tkinter import filedialog
        
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        file_selected = filedialog.askopenfilename(
            title="실행할 프로그램/파일 선택",
            filetypes=[
                ("실행 가능 파일", "*.exe;*.bat;*.cmd;*.ps1;*.lnk;*.url"),
                ("모든 파일", "*.*")
            ]
        )
        root.destroy()
        
        if file_selected:
            file_selected = os.path.normpath(file_selected)
            return {"status": "success", "path": file_selected}
        return {"status": "cancelled", "path": ""}
    except Exception as e:
        return {"status": "error", "message": str(e)}
