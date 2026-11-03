"""Parse administrator argument text without changing stored argv arrays."""


def parse_arguments(value) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return list(value)
    if not isinstance(value, str):
        raise ValueError("args 格式不正确")
    args, text = [], ""
    quoted = closed = in_quotes = False
    index = 0
    while index < len(value):
        char = value[index]
        if in_quotes:
            if char == '"' and index + 1 < len(value) and value[index + 1] == '"':
                text += '"'
                index += 1
            elif char == '"':
                in_quotes, closed = False, True
            else:
                text += char
        elif char == ',':
            if quoted or text.strip():
                args.append(text if quoted else text.strip())
            text, quoted, closed = "", False, False
        elif closed:
            if char.strip():
                raise ValueError("参数的双引号后只能填写英文逗号或空白")
        elif char == '"' and not text.strip():
            text, quoted, in_quotes = "", True, True
        else:
            text += char
        index += 1
    if in_quotes:
        raise ValueError("参数的双引号未闭合")
    if quoted or text.strip():
        args.append(text if quoted else text.strip())
    return args
