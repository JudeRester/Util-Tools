"""
데이터 생성(Data Generator) 서비스 모듈
"""
import random
import eel


@eel.expose
def generate_biz_id(formatted=True, count=1):
    """유효한 한국 사업자등록번호 생성 로직 (체크섬 알고리즘)"""
    weights = [1, 3, 7, 1, 3, 7, 1, 3, 5]
    results = []
    
    count = max(1, min(int(count), 100))
    for _ in range(count):
        digits = [random.randint(1, 9)] + [random.randint(0, 9) for _ in range(8)]
        
        # 1~8자리 체크섬 합산
        chk_sum = sum(w * d for w, d in zip(weights[:8], digits[:8]))
        
        # 9번째 자리 계산
        ninth_product = weights[8] * digits[8]
        chk_sum += (ninth_product // 10) + (ninth_product % 10)
        
        # 마지막 검증 숫자 추가
        digits.append((10 - (chk_sum % 10)) % 10)
        
        raw_val = "".join(map(str, digits))
        if formatted:
            val = f"{raw_val[:3]}-{raw_val[3:5]}-{raw_val[5:]}"
        else:
            val = raw_val
        results.append(val)
        
    return {
        "status": "success",
        "data": results[0] if count == 1 else results,
        "count": len(results)
    }
