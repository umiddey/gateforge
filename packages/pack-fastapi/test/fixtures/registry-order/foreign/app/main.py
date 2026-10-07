"""Fixture: the module that creates the app never calls the registry function."""

from fastapi import FastAPI

app = FastAPI()
