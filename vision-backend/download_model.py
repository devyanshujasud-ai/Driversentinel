"""
download_model.py — Download and extract the dlib 68-point facial landmark model.

Usage:
    python download_model.py

Downloads shape_predictor_68_face_landmarks.dat.bz2 from dlib.net,
decompresses it, and places the .dat file in the same directory.
"""

import bz2
import os
import sys
import urllib.request

MODEL_URL = "http://dlib.net/files/shape_predictor_68_face_landmarks.dat.bz2"
BZ2_PATH = os.path.join(os.path.dirname(__file__), "shape_predictor_68_face_landmarks.dat.bz2")
DAT_PATH = os.path.join(os.path.dirname(__file__), "shape_predictor_68_face_landmarks.dat")


def download():
    if os.path.isfile(DAT_PATH):
        print(f"✓ Model already exists at {DAT_PATH}")
        return

    # Download
    print(f"Downloading {MODEL_URL} …")
    urllib.request.urlretrieve(MODEL_URL, BZ2_PATH, reporthook=_progress)
    print()  # newline after progress

    # Decompress
    print("Decompressing …")
    with bz2.open(BZ2_PATH, "rb") as src, open(DAT_PATH, "wb") as dst:
        while True:
            chunk = src.read(1024 * 1024)  # 1 MB chunks
            if not chunk:
                break
            dst.write(chunk)

    # Clean up compressed file
    os.remove(BZ2_PATH)
    print(f"[OK] Model saved to {DAT_PATH}")


def _progress(block_num: int, block_size: int, total_size: int):
    downloaded = block_num * block_size
    if total_size > 0:
        pct = min(100, downloaded * 100 / total_size)
        mb_done = downloaded / (1024 * 1024)
        mb_total = total_size / (1024 * 1024)
        sys.stdout.write(f"\r  {mb_done:.1f} / {mb_total:.1f} MB ({pct:.0f}%)")
    else:
        mb_done = downloaded / (1024 * 1024)
        sys.stdout.write(f"\r  {mb_done:.1f} MB downloaded")
    sys.stdout.flush()


if __name__ == "__main__":
    download()
