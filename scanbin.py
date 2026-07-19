import pathlib, re
files=[r'C:\Program Files (x86)\DMR\dmr\DMEngine.exe', r'C:\Program Files (x86)\DMR\dmr\ModbusRLib.dll', r'C:\Program Files (x86)\DMR\dmr\Analyzer\DatAnalyzer.dll', r'C:\Program Files (x86)\DMR\dmr\Analyzer\ArfAnalyzer.dll', r'C:\Program Files (x86)\DMR\dmr\Analyzer\GrfAnalyzer.dll', r'C:\Program Files (x86)\DMR\dmr\Analyzer\MCAnalyzer.dll']
for f in files:
    data=pathlib.Path(f).read_bytes()
    found=[]
    for pat in [b'.dat',b'.DAT',b'.arf',b'.ARF',b'.grf',b'.GRF',b'.mc',b'.MC',b'Modbus',b'OPC',b'CSV',b'Excel',b'Export',b'DAT',b'ARF',b'GRF']:
        if pat in data: found.append(pat.decode('latin1'))
    print('\n---', pathlib.Path(f).name, found)
    ss=re.findall(rb'[ -~]{4,}', data)
    count=0
    for s in ss:
        if any(k in s.lower() for k in [b'.dat',b'.arf',b'.grf',b'filter',b'device',b'modbus',b'csv',b'xls']):
            print(s[:160].decode('latin1','ignore'))
            count+=1
            if count>=40: break
