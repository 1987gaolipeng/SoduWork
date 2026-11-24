"""Stream spreadsheet-safe administrative CSV downloads from a database result."""
import csv
import io


def _csv_cell(value):
    # Spreadsheets evaluate formula prefixes even when CSV quotes the field.
    if isinstance(value, str) and (value.startswith(("\t", "\r", "\n")) or
                                   value.lstrip().startswith(("=", "+", "-", "@"))):
        return "'" + value
    return value


async def csv_chunks(rows, fields, values):
    out = io.StringIO(newline="")
    writer = csv.writer(out)
    try:
        writer.writerow(fields)
        yield "\ufeff" + out.getvalue()
        async for batch in rows.partitions(400):
            out.seek(0)
            out.truncate()
            for row in batch:
                writer.writerow(_csv_cell(value) for value in values(row))
            yield out.getvalue()
    finally:
        await rows.close()
