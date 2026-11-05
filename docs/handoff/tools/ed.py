# Exact-match edit helpers that keep each file's line endings.
CR=chr(13);LF=chr(10);CRLF=CR+LF
class F:
    def __init__(self,p):
        self.p=p;raw=open(p,encoding='utf8',newline='').read();self.crlf=CRLF in raw;self.s=raw.replace(CRLF,LF)
    def rep(self,a,b,n=1):
        assert self.s.count(a)==n,(self.p,self.s.count(a),a[:100]);self.s=self.s.replace(a,b);return self
    def cut(self,a,b,new='',keep_b=True):
        i=self.s.index(a);j=self.s.index(b,i+len(a));
        if not keep_b:j+=len(b)
        self.s=self.s[:i]+new+self.s[j:];return self
    def save(self):
        open(self.p,'w',encoding='utf8',newline='').write(self.s.replace(LF,CRLF) if self.crlf else self.s)
