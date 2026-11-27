import pytest
from pydantic import BaseModel, ValidationError

import odd_claude


class Point(BaseModel):
    x: int


def test_skeleton_validates_pydantic_model():
    assert odd_claude is not None
    assert Point(x=1).x == 1
    with pytest.raises(ValidationError):
        Point(x="not-an-int")
