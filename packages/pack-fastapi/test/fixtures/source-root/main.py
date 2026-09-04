from fastapi import FastAPI
from api.routers import router  # type: ignore[import-not-found]

app = FastAPI()
app.include_router(router, prefix="/api/v1")
