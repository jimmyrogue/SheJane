from pathlib import Path

import docx
from PyInstaller.utils.hooks import collect_data_files

package = Path(docx.__file__).resolve().parent
datas = collect_data_files("docx") + [(str(package / "parts" / "hdrftr.py"), "docx/parts")]
