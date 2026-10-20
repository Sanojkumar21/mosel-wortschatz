"""Run the server: python -m mosel  (PORT and HOST from the environment)."""
import logging
import os

import uvicorn

from mosel.main import create_app


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)   # request URLs stay out of the logs
    uvicorn.run(create_app(), host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 8000)),
                proxy_headers=True)


if __name__ == "__main__":
    main()
