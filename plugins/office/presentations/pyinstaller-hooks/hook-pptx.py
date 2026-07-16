from pathlib import Path

import pptx
from PyInstaller.utils.hooks import collect_data_files

package = Path(pptx.__file__).resolve().parent
datas = collect_data_files("pptx", includes=["templates/*"]) + [
    (str(package / "oxml" / "__init__.py"), "pptx/oxml")
]
