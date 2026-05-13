from bs4 import BeautifulSoup
from bs4.element import Tag
import json

def get_explicits(node:Tag):
    def remove_attrs(node:Tag):
        if 'data-hover' in node.attrs:
            node.attrs.pop('data-hover')
        if 'href' in node.attrs:
            node.attrs.pop('href')
        for child in node.children:
            if isinstance(child,Tag):
                remove_attrs(child)
    remove_attrs(node)
    return str(node)



with open("uniques.html",encoding='utf-8') as f:
    soup=BeautifulSoup(f.read(),'lxml')

items=soup.select('a.uniqueitem:has(> span.uniqueName)')

db={}
for item in items:
    #get card name
    s:str=item.attrs['href']  #type:ignore
    s=s[s.rfind('/')+1:]
    s=s.replace('_',' ')
    if item.parent is None:
        print(f'Error parsing {s}')
        continue

    #get prop(stack size) and explicit(rewards)
    uname= item.select_one('.uniqueName')
    utype = item.select_one('.uniqueTypeLine')
    if uname is None:
        print(f'Error not found uname for {s}')
        continue
    if utype is None:
        print(f'Error not found utype for {s}')
        continue
    explicits=item.parent.parent.select('.explicitMod')  #type:ignore
    brief=''
    for e in explicits:
        brief+=get_explicits(e)
    if s not in db:
        db[s]={
            'name':uname.text,
            'basetype':utype.text,
            'type':'unique',
            'brief':f'{brief}',
        }


with open('poedb/uniques.json','w') as f:
    f.write(json.dumps(list(db.values()),indent=2))