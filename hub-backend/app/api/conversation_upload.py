"""Bound multipart resource use before FastAPI binds delivery form parameters."""
from fastapi import HTTPException
from fastapi.routing import APIRoute
from starlette.formparsers import MultiPartException, MultiPartParser

from ..config import get_settings
from ..services.conversation_turns import MAX_DELIVERY_FILES

# The native delivery client uses the same aggregate file budget.
MAX_BATCH_BYTES = 64 * 1024 * 1024
# Allow a full form field (e.g. replacements) plus names, paths and boundaries.
FORM_OVERHEAD_BYTES = 2 * 1024 * 1024
PARSE_CHUNK_BYTES = 64 * 1024


class DeliveryLimitExceeded(MultiPartException):
    """Starlette closes partial upload files when a multipart limit is exceeded."""


class DeliveryParser(MultiPartParser):
    # Keep small parts in memory while larger files roll over to temporary storage.
    spool_max_size = 64 * 1024

    def __init__(self, headers, stream):
        super().__init__(headers, stream, max_files=MAX_DELIVERY_FILES)
        self.file_limit = get_settings().attach_max_mb * 1024 * 1024
        self.batch_bytes = 0

    def on_part_begin(self):
        super().on_part_begin()
        self.file_bytes = 0

    def on_part_data(self, data, start, end):
        if self._current_part.file is not None:
            self.file_bytes += end - start
            self.batch_bytes += end - start
            if self.file_bytes > self.file_limit or self.batch_bytes > MAX_BATCH_BYTES:
                raise DeliveryLimitExceeded("交付文件超过上传大小上限")
        super().on_part_data(data, start, end)


class DeliveryUploadRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def handle(request):
            limit = MAX_BATCH_BYTES + FORM_OVERHEAD_BYTES
            length = request.headers.get("content-length")
            if length is not None:
                try:
                    declared = int(length)
                except ValueError:
                    raise HTTPException(400, "上传请求长度无效") from None
                if declared < 0:
                    raise HTTPException(400, "上传请求长度无效")
                if declared > limit:
                    raise HTTPException(413, "交付请求超过上传大小上限")
            if request.headers.get("content-type", "").partition(";")[0].strip().lower() != "multipart/form-data":
                raise HTTPException(422, "交付文件需要 multipart/form-data")

            async def bounded_stream():
                received = 0
                parsed = 0
                async for chunk in request.stream():
                    received += len(chunk)
                    if received > limit:
                        raise DeliveryLimitExceeded("交付请求超过上传大小上限")
                    for start in range(0, len(chunk), PARSE_CHUNK_BYTES):
                        block = chunk[start:start + PARSE_CHUNK_BYTES]
                        yield block
                        # Starlette has processed this block. Bound the aggregate
                        # field, header and framing bytes independently of uploads.
                        parsed += len(block)
                        if parsed - parser.batch_bytes > FORM_OVERHEAD_BYTES:
                            raise DeliveryLimitExceeded("交付表单元数据超过大小上限")

            parser = DeliveryParser(request.headers, bounded_stream())
            try:
                form = await parser.parse()
            except DeliveryLimitExceeded as error:
                raise HTTPException(413, error.message) from error
            except MultiPartException as error:
                if parser._current_files > MAX_DELIVERY_FILES:
                    raise HTTPException(413, "交付文件数量超过上限") from error
                raise HTTPException(400, error.message) from error
            # Seed Starlette's form cache so FastAPI retains its normal field binding,
            # validation, OpenAPI contract and upload cleanup without a second parse.
            request._form = form
            try:
                return await handler(request)
            finally:
                await request.close()

        return handle
