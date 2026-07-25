import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

import ai
import auth
import bills
import groups
import receipts
from db import DB_PATH, SCHEMA_VERSION, init_db, reset_if_stale
from groups import split_equally

# Re-exported for the test suite, which imports them from `main`.
__all__ = [
    "app",
    "DB_PATH",
    "SCHEMA_VERSION",
    "init_db",
    "reset_if_stale",
    "split_equally",
]

app = FastAPI()
init_db()
for _module in (auth, groups, receipts, bills, ai):
    app.include_router(_module.router)


class AppStatics(StaticFiles):
    """Serve the built PWA with cache headers that can't strand an old bundle.

    Starlette sends no Cache-Control, so browsers fall back to heuristic
    freshness and may reuse index.html for hours. Since index.html names the
    content-hashed bundles, a stale copy runs old JavaScript against a new API —
    which is what produced a wall of validation errors after PR A shipped.

    The hashed assets are immutable by construction and can be cached forever;
    everything that *points* at them must revalidate every time.
    """

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        name = os.path.basename(str(full_path))
        immutable = "/assets/" in str(full_path).replace(os.sep, "/")
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable"
            if immutable and name != "index.html"
            else "no-cache"
        )
        return response


if os.path.isdir("static"):
    app.mount("/", AppStatics(directory="static", html=True), name="static")
