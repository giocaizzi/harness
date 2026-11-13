#!/usr/bin/env bash
# An exporter module wrapped in a factory, an abstract base class and a registry.
set -euo pipefail
mkdir -p src/reports
cat > src/reports/base.py <<'T'
from abc import ABC, abstractmethod


class Exporter(ABC):
    @abstractmethod
    def export(self, rows: list[dict]) -> str: ...
T
cat > src/reports/csv_exporter.py <<'T'
import csv
import io

from reports.base import Exporter


class CsvExporter(Exporter):
    def export(self, rows: list[dict]) -> str:
        out = io.StringIO()
        writer = csv.DictWriter(out, fieldnames=list(rows[0]) if rows else [])
        writer.writeheader()
        writer.writerows(rows)
        return out.getvalue()
T
cat > src/reports/registry.py <<'T'
from reports.base import Exporter

_REGISTRY: dict[str, type[Exporter]] = {}


def register(name: str, cls: type[Exporter]) -> None:
    _REGISTRY[name] = cls


def get(name: str) -> type[Exporter]:
    return _REGISTRY[name]
T
cat > src/reports/factory.py <<'T'
from reports import registry
from reports.csv_exporter import CsvExporter

registry.register("csv", CsvExporter)


class ExporterFactory:
    @staticmethod
    def create(name: str):
        return registry.get(name)()
T
cat > src/reports/job.py <<'T'
from reports.factory import ExporterFactory


def run(rows: list[dict]) -> str:
    return ExporterFactory.create("csv").export(rows)
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
