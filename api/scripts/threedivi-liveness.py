#!/usr/bin/env python3
"""
3DiVi Face SDK liveness (Python Processing Block API).
Usage: python3 threedivi-liveness.py <sdk_path> <modification> <image1.jpg> [image2.jpg ...]
"""
from __future__ import annotations

import json
import os
import sys

if len(sys.argv) < 4:
    print("Usage: threedivi-liveness.py <sdk_path> <modification> <image>...", file=sys.stderr)
    sys.exit(2)

sdk_path = sys.argv[1]
modification = sys.argv[2]
image_paths = sys.argv[3:]
min_confidence = float(os.environ.get("THREEDIVI_LIVENESS_MIN_CONFIDENCE", "0.5"))

sys.path.insert(0, os.path.join(sdk_path, "python_api"))

from face_sdk_3divi import FacerecService  # noqa: E402

dll_path = os.path.join(sdk_path, "lib", "libfacerec.so")
conf_path = os.path.join(sdk_path, "conf", "facerec")
license_path = os.path.join(sdk_path, "license")

service = FacerecService.create_service(dll_path, conf_path, license_path)

detector = service.create_processing_block(
    {"unit_type": "FACE_DETECTOR", "modification": "ssyv_light", "use_cuda": False}
)
fitter = service.create_processing_block(
    {"unit_type": "FACE_FITTER", "modification": "fda", "use_cuda": False}
)
liveness_estimator = service.create_processing_block(
    {
        "unit_type": "LIVENESS_ESTIMATOR",
        "modification": modification,
        "use_cuda": False,
    }
)


def read_image(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


best = {"passed": False, "verdict": "UNKNOWN", "confidence": 0.0, "faces_detected": 0}

for image_path in image_paths:
    data = service.create_context_from_encoded_image(read_image(image_path))
    detector(data)

    objects = list(data["objects"])
    if len(objects) != 1:
        continue

    fitter(data)
    liveness_estimator(data)

    for obj in objects:
        verdict = obj["liveness"]["value"].get_string()
        confidence = float(obj["liveness"]["confidence"].get_double())
        passed = verdict == "REAL" and confidence >= min_confidence

        if passed and confidence > best["confidence"]:
            best = {"passed": True, "verdict": verdict, "confidence": confidence, "faces_detected": 1}
        elif not best["passed"] and confidence > best["confidence"]:
            best = {
                "passed": passed,
                "verdict": verdict,
                "confidence": confidence,
                "faces_detected": 1,
            }

print(json.dumps(best))
