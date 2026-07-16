import os
from threading import Lock
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer


MODEL_NAME = os.getenv("BGE_MODEL_NAME", "BAAI/bge-base-en-v1.5")
API_KEY = os.getenv("EMBEDDING_API_KEY", "")
model: SentenceTransformer | None = None
model_lock = Lock()


class EmbeddingRequest(BaseModel):
    input: str | list[str]
    model: str | None = None
    dimensions: int | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    model = SentenceTransformer(MODEL_NAME, device="cpu")
    yield
    model = None


app = FastAPI(title="Atlas BGE Embedding Service", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "status": "ok" if model is not None else "loading",
        "model": MODEL_NAME,
        "dimensions": 768,
    }


@app.post("/v1/embeddings")
def embeddings(request: EmbeddingRequest, authorization: str | None = Header(default=None)):
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="Invalid API key")
    if model is None:
        raise HTTPException(status_code=503, detail="Embedding model is loading")
    if request.dimensions not in (None, 768):
        raise HTTPException(status_code=400, detail="BAAI/bge-base-en-v1.5 produces 768 dimensions")

    inputs = [request.input] if isinstance(request.input, str) else request.input
    if not inputs:
        raise HTTPException(status_code=400, detail="input must not be empty")
    if len(inputs) > 64:
        raise HTTPException(status_code=400, detail="A maximum of 64 inputs is allowed per request")
    inputs = [str(value) for value in inputs]

    with model_lock:
        vectors = model.encode(
            inputs,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
    return {
        "object": "list",
        "model": MODEL_NAME,
        "data": [
            {"object": "embedding", "index": index, "embedding": vector.tolist()}
            for index, vector in enumerate(vectors)
        ],
        "usage": {
            "prompt_tokens": sum(len(text.split()) for text in inputs),
            "total_tokens": sum(len(text.split()) for text in inputs),
        },
    }
